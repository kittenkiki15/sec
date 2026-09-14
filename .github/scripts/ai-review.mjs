#!/usr/bin/env node
/**
 * PR の差分を OpenAI API でレビューし、結果を GitHub のレビューとして投稿する。
 *
 * 必要な環境変数:
 *   OPENAI_API_KEY      OpenAI の API キー
 *   GITHUB_TOKEN        pull-requests: write 権限を持つトークン
 *   GITHUB_REPOSITORY   "owner/repo"
 *   PR_NUMBER           レビュー対象の PR 番号
 *
 * 任意の環境変数:
 *   AI_REVIEW_MODEL             既定 "gpt-5.6-terra"
 *   AI_REVIEW_LANGUAGE          既定 "ja"
 *   AI_REVIEW_MAX_DIFF_BYTES    差分全体の上限。既定 200000
 *   AI_REVIEW_MAX_FILE_BYTES    1 ファイルあたりの上限。既定 20000
 *   AI_REVIEW_MAX_FINDINGS      投稿する指摘の上限。既定 20
 *   AI_REVIEW_REASONING_EFFORT  指定時のみ reasoning_effort として送信
 *   OPENAI_BASE_URL             既定 "https://api.openai.com/v1"
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { OPENAI_API_KEY, GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, AI_REVIEW_REASONING_EFFORT } =
  process.env;

const MODEL = process.env.AI_REVIEW_MODEL || 'gpt-5.6-terra';
const LANGUAGE = process.env.AI_REVIEW_LANGUAGE || 'ja';
const OPENAI_BASE_URL = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
const MAX_DIFF_BYTES = Number(process.env.AI_REVIEW_MAX_DIFF_BYTES || 200_000);
const MAX_FILE_BYTES = Number(process.env.AI_REVIEW_MAX_FILE_BYTES || 20_000);
const MAX_FINDINGS = Number(process.env.AI_REVIEW_MAX_FINDINGS || 20);
const PER_PAGE = 100;
const MAX_FILE_PAGES = 10;

const GUIDELINES_PATH = '.github/ai-review-guidelines.md';
const MARKER = '<!-- ai-review:gpt -->';

/** レビュー対象から外すパス。生成物・ロックファイル・バイナリなど。 */
const EXCLUDED = [
  /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb)$/,
  /(^|\/)(dist|build|out|coverage|node_modules)\//,
  /\.min\.(js|css)$/,
  /\.(png|jpe?g|gif|ico|webp|avif|woff2?|ttf|otf|eot|pdf|zip|gz|wasm)$/i,
];

const SEVERITY_ORDER = { critical: 0, major: 1, minor: 2, nit: 3 };
const SEVERITY_LABEL = {
  critical: '🔴 critical',
  major: '🟠 major',
  minor: '🟡 minor',
  nit: '🔵 nit',
};

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function notice(message) {
  console.log(`::notice::${message}`);
}

// --------------------------------------------------------------------------
// GitHub API
// --------------------------------------------------------------------------

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    const error = new Error(
      `GitHub API ${options.method || 'GET'} ${path} -> ${res.status}: ${body}`,
    );
    error.status = res.status;
    throw error;
  }
  return res.status === 204 ? null : res.json();
}

/**
 * PR の変更ファイルを取得する。
 * ページ上限に達した場合は truncated を立てて呼び出し元に知らせる。
 * 黙って打ち切ると、レビューされなかったファイルがあることが誰にも分からなくなるため。
 */
export async function fetchChangedFiles(repo, prNumber, fetchPage) {
  const getPage =
    fetchPage ?? ((page) => gh(`/repos/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`));

  const files = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const batch = await getPage(page);
    files.push(...batch);
    if (batch.length < PER_PAGE) return { files, truncated: false };
  }
  return { files, truncated: true };
}

// --------------------------------------------------------------------------
// 差分の整形
// --------------------------------------------------------------------------

/**
 * unified diff の patch から、新しい側 (RIGHT) で行コメントを付けられる行番号を集める。
 * 追加行と文脈行が対象。削除行は新しい側に存在しないので除く。
 */
export function commentableLines(patch) {
  const lines = new Set();
  if (!patch) return lines;
  let newLine = 0;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (line.startsWith('+') || line.startsWith(' ')) {
      lines.add(newLine);
      newLine += 1;
    }
    // '-' 行と '\ No newline at end of file' は新しい側の行数を進めない
  }
  return lines;
}

const TRUNCATION_NOTICE = '\n… (この先は長さ上限のため省略)';

/** 戻り値の長さが limit を超えないよう、注記の分をあらかじめ差し引いて切り詰める。 */
function truncate(text, limit) {
  if (text.length <= limit) return { text, truncated: false };
  const room = Math.max(0, limit - TRUNCATION_NOTICE.length);
  return { text: `${text.slice(0, room)}${TRUNCATION_NOTICE}`, truncated: true };
}

export function buildDiffSections(files, limits = {}) {
  const { maxTotalBytes = MAX_DIFF_BYTES, maxFileBytes = MAX_FILE_BYTES } = limits;
  const sections = [];
  const skipped = [];
  let total = 0;

  for (const file of files) {
    if (EXCLUDED.some((re) => re.test(file.filename))) {
      skipped.push(`${file.filename} (生成物・ロックファイル等として除外)`);
      continue;
    }
    if (!file.patch) {
      skipped.push(
        `${file.filename} (差分が大きすぎる、またはバイナリのため GitHub が patch を返さず)`,
      );
      continue;
    }
    // 追加後の合計で判断しないと、1 ファイル分だけ上限を超えて送信してしまう。
    const remaining = maxTotalBytes - total;
    if (remaining <= 0) {
      skipped.push(`${file.filename} (差分全体の上限 ${maxTotalBytes} バイトに到達)`);
      continue;
    }

    const { text, truncated } = truncate(file.patch, Math.min(maxFileBytes, remaining));
    total += text.length;
    sections.push(
      `### ${file.filename} (${file.status}, +${file.additions} -${file.deletions})` +
        `${truncated ? ' ※一部省略' : ''}\n\`\`\`diff\n${text}\n\`\`\``,
    );
  }

  return { sections, skipped, totalBytes: total };
}

// --------------------------------------------------------------------------
// OpenAI API
// --------------------------------------------------------------------------

const RESPONSE_SCHEMA = {
  name: 'code_review',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'findings'],
    properties: {
      summary: {
        type: 'string',
        description: '変更内容の要約と全体的な所見。数文程度。',
      },
      findings: {
        type: 'array',
        description: '個別の指摘。問題が無ければ空配列。',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'line', 'severity', 'category', 'title', 'detail', 'suggestion'],
          properties: {
            file: { type: 'string', description: '差分に含まれるファイルのパス' },
            line: {
              type: ['integer', 'null'],
              description: '変更後ファイルの行番号。特定できない場合は null。',
            },
            severity: { type: 'string', enum: ['critical', 'major', 'minor', 'nit'] },
            category: {
              type: 'string',
              description: 'correctness / security / performance / design / test / style など',
            },
            title: { type: 'string', description: '一行の要約' },
            detail: { type: 'string', description: '何が問題で、どう壊れるかの具体的な説明' },
            suggestion: {
              type: ['string', 'null'],
              description: '修正案のコード片。無ければ null。',
            },
          },
        },
      },
    },
  },
};

/**
 * モデルによって受け付けるパラメータが異なるため、
 * 未対応パラメータを理由に 400 が返った場合はそれを外して一度だけ再試行する。
 */
async function callOpenAI(payload) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.ok) return res.json();

    const body = await res.text();

    if (res.status === 400) {
      const unsupported =
        /Unsupported parameter: '([^']+)'|Unrecognized request argument supplied: (\w+)|'(\w+)' is not supported/.exec(
          body,
        );
      const param = unsupported && (unsupported[1] || unsupported[2] || unsupported[3]);
      if (param && param in payload) {
        notice(`モデル ${MODEL} はパラメータ ${param} を受け付けないため、除外して再試行します。`);
        delete payload[param];
        continue;
      }
    }

    if (res.status === 429 || res.status >= 500) {
      const waitMs = 2000 * 2 ** attempt;
      notice(`OpenAI API が ${res.status} を返しました。${waitMs}ms 待って再試行します。`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    throw new Error(`OpenAI API ${res.status}: ${body}`);
  }
  throw new Error('OpenAI API への再試行がすべて失敗しました。');
}

function buildMessages({ pr, guidelines, diffText, skipped }) {
  const system = [
    'あなたは経験豊富なソフトウェアエンジニアで、GitHub のプルリクエストをレビューします。',
    `回答は${LANGUAGE === 'ja' ? '日本語' : '英語'}で書いてください。`,
    '',
    '守ること:',
    '- 差分から実際に確認できることだけを指摘する。差分に無いコードの挙動を想像で断定しない。',
    '- 各指摘には「何が起きるか」を具体的に書く。抽象的な原則論だけの指摘はしない。',
    '- 好みの問題や、自動整形ツールが直せる体裁は指摘しない。',
    '- 同じ根本原因の指摘は 1 件にまとめる。',
    '- 問題が見つからなければ findings を空配列にする。無理に指摘を作らない。',
    '- line は変更後ファイルの行番号を指す。差分に現れない行は指さず、その場合は null にする。',
    `- 指摘は重大な順に並べ、多くても ${MAX_FINDINGS} 件に絞る。`,
    '',
    '重大度の基準:',
    '- critical: データ破損、セキュリティ欠陥、確実に落ちるバグ',
    '- major: 条件次第で誤動作する、設計上の重大な問題',
    '- minor: 限定的な不具合、保守性の問題',
    '- nit: 些細な改善提案',
  ].join('\n');

  const user = [
    `# プルリクエスト #${pr.number}: ${pr.title}`,
    '',
    pr.body ? `## 説明\n${pr.body}` : '## 説明\n(記載なし)',
    '',
    guidelines ? `## このリポジトリのレビュー方針\n${guidelines}` : '',
    '',
    '## 差分',
    diffText,
    skipped.length
      ? `\n## レビュー対象外のファイル\n${skipped.map((s) => `- ${s}`).join('\n')}`
      : '',
  ]
    .filter(Boolean)
    .join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

// --------------------------------------------------------------------------
// 投稿
// --------------------------------------------------------------------------

function renderFinding(finding, { withLocation }) {
  const location = withLocation
    ? `**${finding.file}${finding.line ? `:${finding.line}` : ''}** — `
    : '';
  const parts = [
    `${SEVERITY_LABEL[finding.severity] ?? finding.severity} \`${finding.category}\` ${location}${finding.title}`,
    '',
    finding.detail,
  ];
  if (finding.suggestion) {
    // GitHub の ```suggestion は「コメント対象の行をそのまま置き換える」記法のため、
    // 生成された断片がその形になっている保証がない。誤った適用ボタンを出さないよう
    // 通常のコードブロックとして示す。
    parts.push('', '修正案:', '```', finding.suggestion, '```');
  }
  return parts.join('\n');
}

function renderBody({ summary, orphans, skipped, truncatedNote }) {
  const sections = [MARKER, `## 🤖 AI コードレビュー (\`${MODEL}\`)`, '', summary];

  if (orphans.length) {
    sections.push(
      '',
      '### 行に紐づけられなかった指摘',
      '',
      ...orphans.map((f) => `${renderFinding(f, { withLocation: true })}\n`),
    );
  }

  if (truncatedNote) sections.push('', truncatedNote);

  if (skipped.length) {
    sections.push(
      '',
      '<details><summary>レビュー対象外のファイル</summary>',
      '',
      ...skipped.map((s) => `- ${s}`),
      '',
      '</details>',
    );
  }

  sections.push(
    '',
    '---',
    '_このレビューは自動生成されたものです。指摘の妥当性は必ず人間が判断してください。_',
  );

  return sections.join('\n');
}

async function postReview(repo, prNumber, headSha, { body, comments }) {
  try {
    await gh(`/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: headSha, event: 'COMMENT', body, comments }),
    });
    return comments.length;
  } catch (error) {
    if (!comments.length) throw error;
    // 行の指定が GitHub に拒否された場合は、指摘を本文に畳んで投稿し直す。
    notice(`行コメント付きの投稿に失敗したため、本文にまとめて投稿します: ${error.message}`);
    const merged = [
      body,
      '',
      '### 指摘',
      '',
      ...comments.map((c) => `**${c.path}:${c.line}**\n\n${c.body}\n`),
    ].join('\n');
    await gh(`/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ commit_id: headSha, event: 'COMMENT', body: merged }),
    });
    return 0;
  }
}

// --------------------------------------------------------------------------

async function main() {
  for (const [name, value] of Object.entries({
    OPENAI_API_KEY,
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    PR_NUMBER,
  })) {
    if (!value) fail(`環境変数 ${name} が設定されていません。`);
  }

  const repo = GITHUB_REPOSITORY;
  const prNumber = Number(PR_NUMBER);

  const pr = await gh(`/repos/${repo}/pulls/${prNumber}`);
  if (pr.state !== 'open') {
    notice(`PR #${prNumber} は ${pr.state} のためレビューをスキップします。`);
    return;
  }

  const { files, truncated: fileListTruncated } = await fetchChangedFiles(repo, prNumber);
  const { sections, skipped, totalBytes } = buildDiffSections(files);

  if (fileListTruncated) {
    skipped.push(
      `変更ファイルが ${PER_PAGE * MAX_FILE_PAGES} 件を超えたため、以降のファイルは取得していません。`,
    );
  }

  if (!sections.length) {
    notice('レビュー対象のファイルがありません。');
    return;
  }
  console.log(`レビュー対象 ${sections.length} ファイル / 差分 ${totalBytes} バイト`);

  const guidelines = await readFile(GUIDELINES_PATH, 'utf8').catch(() => null);

  const payload = {
    model: MODEL,
    messages: buildMessages({ pr, guidelines, diffText: sections.join('\n\n'), skipped }),
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
    max_completion_tokens: 16_000,
  };
  if (AI_REVIEW_REASONING_EFFORT) payload.reasoning_effort = AI_REVIEW_REASONING_EFFORT;

  const completion = await callOpenAI(payload);
  const message = completion.choices?.[0]?.message;
  if (message?.refusal) fail(`モデルがレビューを拒否しました: ${message.refusal}`);
  if (!message?.content) fail('モデルの応答が空でした。');

  let review;
  try {
    review = JSON.parse(message.content);
  } catch {
    fail(`モデルの応答を JSON として解釈できませんでした: ${message.content.slice(0, 500)}`);
  }

  const lineIndex = new Map(files.map((f) => [f.filename, commentableLines(f.patch)]));

  const findings = (review.findings ?? [])
    .filter((f) => f && SEVERITY_LABEL[f.severity])
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_FINDINGS);

  const comments = [];
  const orphans = [];
  for (const finding of findings) {
    const lines = lineIndex.get(finding.file);
    if (finding.line && lines?.has(finding.line)) {
      comments.push({
        path: finding.file,
        line: finding.line,
        side: 'RIGHT',
        body: renderFinding(finding, { withLocation: false }),
      });
    } else {
      orphans.push(finding);
    }
  }

  const truncatedNote =
    totalBytes >= MAX_DIFF_BYTES
      ? `⚠️ 差分が大きいため、上限 ${MAX_DIFF_BYTES} バイトまでをレビューしました。`
      : null;

  const body = renderBody({
    summary: review.summary || '(要約なし)',
    orphans,
    skipped,
    truncatedNote,
  });

  const posted = await postReview(repo, prNumber, pr.head.sha, { body, comments });
  const usage = completion.usage;
  console.log(
    `投稿完了: 指摘 ${findings.length} 件 (行コメント ${posted} 件) / ` +
      `トークン in ${usage?.prompt_tokens ?? '?'} out ${usage?.completion_tokens ?? '?'}`,
  );
}

// import してテストできるよう、直接実行されたときだけ main を走らせる。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => fail(error.stack || String(error)));
}
