/**
 * ゴールデンテストのファイル形式を解析し、実行するためのハーネス。
 *
 * ゴールデンテストは `tests/golden/*.txt` に置かれ、言語仕様そのものを表す。
 * 実装より先にここへケースを足し、それを緑にする形で開発を進める。
 *
 * 形式:
 *
 * ```text
 * "行頭が二重引用符の行はコメント（Smalltalk のコメントに合わせている）
 *
 * 3 + 4 * 2
 * => 14
 *
 * "式も期待値も複数行に書ける
 * | a |
 * a := 3.
 * ^ a + 1
 * => 4
 * ```
 *
 * - 空行がケースの区切り。
 * - ケース内で最初に現れる `=>` で始まる行から後ろが期待値。
 * - 行末の空白は無視される。
 */

/** ゴールデンテストの 1 ケース。 */
export interface GoldenCase {
  /** 評価する式。複数行のことがある。 */
  readonly source: string;
  /**
   * 式を評価するときのシートの状態。セル参照から、そのセルに入っている内容への対応。
   * 内容は原文テキストで、`=` で始まれば数式（要件 F-5-1）。
   * 指定の無いセルは現れない。ケースごとに独立している。
   */
  readonly sheet: ReadonlyMap<string, string>;
  /** 期待される評価結果の表記。 */
  readonly expected: string;
  /** ファイル内での式の開始行（1 始まり）。失敗時の報告に使う。 */
  readonly line: number;
}

/** ゴールデンテストのファイル形式が壊れているときに送出される。 */
export class GoldenParseError extends Error {
  readonly line: number;

  constructor(message: string, line: number) {
    super(message);
    this.name = 'GoldenParseError';
    this.line = line;
  }
}

/** 式を評価し、期待値と比較できる表記に変換する関数。 */
export type GoldenEvaluator = (source: string, sheet: ReadonlyMap<string, string>) => string;

/** 期待どおりにならなかったケース。 */
export interface GoldenFailure {
  readonly testCase: GoldenCase;
  /** 実際の評価結果。評価が例外で終わった場合は null。 */
  readonly actual: string | null;
  /** 評価中に送出された例外のメッセージ。正常に評価できた場合は null。 */
  readonly thrown: string | null;
}

const COMMENT_PREFIX = '"';
const EXPECT_PREFIX = '=>';
const DIRECTIVE_PREFIX = '!';

/** ADR-0007 D-2 のセル参照の形。`!` は二項セレクタの文字ではないので、式と衝突しない。 */
const CELL_REFERENCE = /^[A-Z]+[0-9]+$/;

interface SourceLine {
  readonly text: string;
  readonly no: number;
}

/**
 * ゴールデンテストのファイル内容を解析する。
 *
 * @param text ファイルの内容
 * @param fileName エラーメッセージに使うファイル名
 * @throws {GoldenParseError} 形式が壊れている場合
 */
export function parseGoldenFile(text: string, fileName = '<golden>'): GoldenCase[] {
  const blocks: SourceLine[][] = [];
  let current: SourceLine[] = [];

  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (const [index, raw] of lines.entries()) {
    const line = raw.replace(/\s+$/, '');

    if (line.trimStart().startsWith(COMMENT_PREFIX)) continue;

    if (line.trim() === '') {
      if (current.length > 0) {
        blocks.push(current);
        current = [];
      }
      continue;
    }

    current.push({ text: line, no: index + 1 });
  }
  if (current.length > 0) blocks.push(current);

  return blocks.map((block) => parseBlock(block, fileName));
}

/** `!A1 = 内容` の形のシートディレクティブを 1 行解析する。 */
function parseDirective(line: SourceLine, fileName: string): { cell: string; content: string } {
  const text = line.text.trimStart().slice(DIRECTIVE_PREFIX.length);
  const separator = text.indexOf('=');
  if (separator < 0) {
    throw new GoldenParseError(
      `${fileName}:${line.no}: セルの指定は "!A1 = 内容" の形で書いてください。`,
      line.no,
    );
  }

  const cell = text.slice(0, separator).trim();
  if (!CELL_REFERENCE.test(cell)) {
    throw new GoldenParseError(
      `${fileName}:${line.no}: "${cell}" はセル参照の形ではありません。` +
        `大文字の英字に続けて数字を書きます（例: A1）。`,
      line.no,
    );
  }

  // 最初の `=` だけを区切りとする。内容の側に数式（`=A1 + 1`）を書けるようにするため。
  const content = text.slice(separator + 1).trim();
  if (content === '') {
    throw new GoldenParseError(
      `${fileName}:${line.no}: セル ${cell} の内容が空です。` +
        `空のセルを表したい場合はその行を書きません。`,
      line.no,
    );
  }

  return { cell, content };
}

function parseBlock(block: readonly SourceLine[], fileName: string): GoldenCase {
  const head = block[0];
  if (head === undefined) {
    throw new GoldenParseError(`${fileName}: 内部エラー: 空のケースを解析しようとしました。`, 0);
  }

  const sheet = new Map<string, string>();
  let bodyStart = 0;
  for (; bodyStart < block.length; bodyStart += 1) {
    const line = block[bodyStart];
    if (line === undefined || !line.text.trimStart().startsWith(DIRECTIVE_PREFIX)) break;

    const { cell, content } = parseDirective(line, fileName);
    if (sheet.has(cell)) {
      throw new GoldenParseError(
        `${fileName}:${line.no}: セル ${cell} の指定が重複しています。`,
        line.no,
      );
    }
    sheet.set(cell, content);
  }

  const body = block.slice(bodyStart);
  for (const line of body) {
    if (line.text.trimStart().startsWith(DIRECTIVE_PREFIX)) {
      throw new GoldenParseError(
        `${fileName}:${line.no}: セルの指定は式より前に置いてください。`,
        line.no,
      );
    }
  }

  const first = body[0];
  if (first === undefined) {
    throw new GoldenParseError(`${fileName}:${head.no}: セルの指定だけで式がありません。`, head.no);
  }

  const expectIndex = body.findIndex((line) => line.text.trimStart().startsWith(EXPECT_PREFIX));
  if (expectIndex < 0) {
    throw new GoldenParseError(
      `${fileName}:${first.no}: 期待値がありません。ケースには "=>" で始まる行が必要です。`,
      first.no,
    );
  }

  const expectLine = body[expectIndex];
  if (expectIndex === 0 || expectLine === undefined) {
    throw new GoldenParseError(`${fileName}:${first.no}: "=>" の前に式がありません。`, first.no);
  }

  const source = body
    .slice(0, expectIndex)
    .map((line) => line.text)
    .join('\n')
    .trim();

  const expectedHead = expectLine.text.trimStart().slice(EXPECT_PREFIX.length);
  const rest = body.slice(expectIndex + 1).map((line) => line.text);
  const expected = [expectedHead, ...rest].join('\n').trim();

  if (expected === '') {
    throw new GoldenParseError(`${fileName}:${expectLine.no}: 期待値が空です。`, expectLine.no);
  }

  return { source, expected, line: first.no, sheet };
}

/**
 * 全ケースを評価し、期待どおりにならなかったものを返す。
 * 1 件失敗しても残りの評価は続ける。仕様のどこまでが通っているかを一度に把握するため。
 */
export function runGoldenCases(
  cases: readonly GoldenCase[],
  evaluate: GoldenEvaluator,
): GoldenFailure[] {
  const failures: GoldenFailure[] = [];

  for (const testCase of cases) {
    let actual: string;
    try {
      actual = evaluate(testCase.source, testCase.sheet);
    } catch (error) {
      failures.push({
        testCase,
        actual: null,
        thrown: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (actual !== testCase.expected) {
      failures.push({ testCase, actual, thrown: null });
    }
  }

  return failures;
}

/** 失敗したケースを、ファイルと行を辿れる形の文字列にまとめる。 */
export function formatGoldenFailures(failures: readonly GoldenFailure[], fileName: string): string {
  const header = `${fileName}: ${failures.length} 件のゴールデンテストが失敗しました。`;

  const details = failures.map(({ testCase, actual, thrown }) => {
    const outcome = thrown === null ? `実際  : ${actual}` : `例外  : ${thrown}`;
    return [
      `${fileName}:${testCase.line}`,
      `  式    : ${testCase.source.split('\n').join('\n          ')}`,
      `  期待値: ${testCase.expected}`,
      `  ${outcome}`,
    ].join('\n');
  });

  return [header, ...details].join('\n\n');
}
