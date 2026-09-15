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
 * #(1 2 3)
 *   inject: 0
 *   into: [:a :b | a + b]
 * => 6
 * ```
 *
 * - 空行がケースの区切り。
 * - ケース内で最初に現れる `=>` で始まる行から後ろが期待値。
 * - 行末の空白は無視される。
 *
 * セルに値が入った状態で評価したい場合は、式より前にシートディレクティブを置く
 * （ADR-0009）。区切りはセルへの代入と同じ `:=`（ADR-0007 D-3）。
 *
 * ```text
 * !A1 := 1
 * !B1 := =A1 + 1
 * B1
 * => 2
 * ```
 *
 * 原文をマクロとして読ませたい場合は、ケースの最初の行に `!macro` を置く（ADR-0018）。
 * 数式とマクロは開始記号が違い、同じ原文でも結果が変わる（仕様書 §7）。
 *
 * ```text
 * !macro
 * | a |
 * a := 3.
 * ^ a + 1
 * => 4
 * ```
 *
 * `!macro` にメッセージを添えると、原文をマクロ定義（宣言部付き）として読み、
 * そのメッセージを送って評価する。
 *
 * ```text
 * !macro from: 1 to: 3
 * from: start to: end
 *     ^ start + end
 * => 4
 * ```
 *
 * まだ実装が無くて緑にできないケースには、緑になるマイルストーンを添える（ADR-0019）。
 * **保留のケースは落ちても失敗にしないが、通ってしまえば失敗になる。**
 * 印を外し忘れたケースが検査の外に残らないようにするため。
 *
 * ```text
 * !pending m3
 * !A1 := 1
 * A1 + 1
 * => 2
 * ```
 */

/**
 * ケースの原文をどの開始記号で読むか（仕様書 §7）。
 * 数式は式ちょうど 1 つ、マクロは一時変数と文の列を持てる。
 */
export type GoldenKind = 'formula' | 'macro';

/** ゴールデンテストの 1 ケース。 */
export interface GoldenCase {
  /** 評価する式。複数行のことがある。 */
  readonly source: string;
  /** 原文をどう読むか。`!macro` ディレクティブの無いケースは数式（ADR-0018）。 */
  readonly kind: GoldenKind;
  /**
   * マクロ定義を起動するメッセージ（`!macro from: 1 to: 3` の `from: 1 to: 3`）。
   * `null` なら原文は宣言部を持たない本体で、そのまま実行する（仕様書 §7.1）。
   */
  readonly send: string | null;
  /**
   * 式を評価するときのシートの状態。セル参照から、そのセルに入っている内容への対応。
   * 内容は原文テキストで、`=` で始まれば数式（要件 F-5-1）。
   * 指定の無いセルは現れない。ケースごとに独立している。
   */
  readonly sheet: ReadonlyMap<string, string>;
  /**
   * このケースが緑になるマイルストーン（`m3`）。`null` なら今すぐ通っていなければならない。
   * **保留のケースは落ちても失敗にしないが、通ってしまえば失敗になる**（ADR-0019）。
   */
  readonly pending: string | null;
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

/**
 * 評価器に渡す入力。**期待値と行番号は渡さない。**
 * 評価に関係しないうえ、評価器が期待値を覗ける形にしたくない。
 */
export type GoldenInput = Pick<GoldenCase, 'source' | 'sheet' | 'kind' | 'send'>;

/** 式を評価し、期待値と比較できる表記に変換する関数。 */
export type GoldenEvaluator = (input: GoldenInput) => string;

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

/** セルへの代入の記法に合わせる（ADR-0007 D-3 の `B14 := total`）。 */
const DIRECTIVE_SEPARATOR = ':=';

/** 原文をマクロとして読ませるディレクティブ（ADR-0018）。 */
const MACRO_DIRECTIVE = '!macro';

/** ケースを保留にするディレクティブ（ADR-0019）。 */
const PENDING_DIRECTIVE = '!pending';

/** マイルストーン名。タグの綴りに合わせる（ADR-0006 の `m0.5` / `m1` / `m3.5`）。 */
const MILESTONE = /^m[0-9]+(\.5)?$/;

/**
 * `!macro` か `!macro <送信>` の行か。
 * `!macros` のように続きが語の一部になっているものは含めない。
 */
const isMacroDirective = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed === MACRO_DIRECTIVE || trimmed.startsWith(`${MACRO_DIRECTIVE} `);
};

/**
 * `!pending <マイルストーン>` の行か。
 * `!pendings` のように続きが語の一部になっているものは含めない。
 */
const isPendingDirective = (text: string): boolean => {
  const trimmed = text.trim();
  return trimmed === PENDING_DIRECTIVE || trimmed.startsWith(`${PENDING_DIRECTIVE} `);
};

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

/**
 * `!pending <マイルストーン>` を 1 行解析し、マイルストーン名を返す。
 *
 * **名前を検証するのは、綴りの誤りを黙って通さないため。** `!pending m33` を受け付けると、
 * どのマイルストーンでも外されない印になり、保留が永久に残る。
 */
function parsePending(line: SourceLine, fileName: string): string {
  const milestone = line.text.trim().slice(PENDING_DIRECTIVE.length).trim();
  if (!MILESTONE.test(milestone)) {
    throw new GoldenParseError(
      `${fileName}:${line.no}: "${PENDING_DIRECTIVE}" には、そのケースが緑になる` +
        `マイルストーンを "${PENDING_DIRECTIVE} m3" の形で添えてください` +
        `（要件定義書 §8 の M0〜M7 に対応する m0 / m0.5 / m1 …）。`,
      line.no,
    );
  }
  return milestone;
}

/** `!A1 := 内容` の形のシートディレクティブを 1 行解析する。 */
function parseDirective(line: SourceLine, fileName: string): { cell: string; content: string } {
  const text = line.text.trimStart().slice(DIRECTIVE_PREFIX.length);
  const separator = text.indexOf(DIRECTIVE_SEPARATOR);
  if (separator < 0) {
    throw new GoldenParseError(
      `${fileName}:${line.no}: セルの指定は "!A1 := 内容"、` +
        `マクロの指定は "${MACRO_DIRECTIVE}"、保留の指定は "${PENDING_DIRECTIVE} m3" の` +
        `形で書いてください。` +
        `セルへの代入は ":=" と書きます（ADR-0007 D-3）。`,
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

  // 最初の `:=` だけを区切りとする。内容の側に数式（`=A1 + 1`）や
  // `:=` を含む文字列を書けるようにするため。
  const content = text.slice(separator + DIRECTIVE_SEPARATOR.length).trim();
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

  // ケースの最初の行にだけ置ける。位置を 1 箇所に固定して、同じことの書き方を増やさない。
  const kind: GoldenKind = isMacroDirective(head.text) ? 'macro' : 'formula';
  const send =
    kind === 'macro' ? head.text.trim().slice(MACRO_DIRECTIVE.length).trim() || null : null;
  if (kind === 'macro') bodyStart = 1;

  // `!macro` の次、セルの指定より前。位置を 1 箇所に固定して、同じことの書き方を増やさない。
  const pendingLine = block[bodyStart];
  let pending: string | null = null;
  if (pendingLine !== undefined && isPendingDirective(pendingLine.text)) {
    pending = parsePending(pendingLine, fileName);
    bodyStart += 1;
  }

  for (; bodyStart < block.length; bodyStart += 1) {
    const line = block[bodyStart];
    if (line === undefined || !line.text.trimStart().startsWith(DIRECTIVE_PREFIX)) break;

    if (isMacroDirective(line.text)) {
      throw new GoldenParseError(
        `${fileName}:${line.no}: "${MACRO_DIRECTIVE}" はケースの最初の行に書いてください。`,
        line.no,
      );
    }

    if (isPendingDirective(line.text)) {
      throw new GoldenParseError(
        `${fileName}:${line.no}: "${PENDING_DIRECTIVE}" は` +
          `${kind === 'macro' ? `"${MACRO_DIRECTIVE}" の次の行、` : 'ケースの最初の行、'}` +
          `セルの指定より前に 1 つだけ書いてください。`,
        line.no,
      );
    }

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
        `${fileName}:${line.no}: ディレクティブ（! で始まる行）は式より前に置いてください。`,
        line.no,
      );
    }
  }

  const first = body[0];
  if (first === undefined) {
    throw new GoldenParseError(
      `${fileName}:${head.no}: ディレクティブだけで式がありません。`,
      head.no,
    );
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

  return { source, kind, send, pending, expected, line: first.no, sheet };
}

/**
 * 全ケースを評価し、期待どおりにならなかったものを返す。
 * 1 件失敗しても残りの評価は続ける。仕様のどこまでが通っているかを一度に把握するため。
 *
 * **保留のケース（`!pending`）は落ちても失敗にしない。** まだ実装が無いことは既知だからである。
 * **ただし通ってしまったら失敗にする**（ADR-0019）。黙って見逃すと、印が古いことと
 * 保留のままであることが区別できなくなり、外し忘れた印が網羅の穴として残る。
 */
export function runGoldenCases(
  cases: readonly GoldenCase[],
  evaluate: GoldenEvaluator,
): GoldenFailure[] {
  const failures: GoldenFailure[] = [];

  for (const testCase of cases) {
    let actual: string;
    try {
      const { source, sheet, kind, send } = testCase;
      actual = evaluate({ source, sheet, kind, send });
    } catch (error) {
      // 保留のケースは、評価器がそのノードを知らずに投げるのが正常な姿。
      if (testCase.pending === null) {
        failures.push({
          testCase,
          actual: null,
          thrown: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    const matched = actual === testCase.expected;
    if (matched !== (testCase.pending === null)) {
      failures.push({ testCase, actual, thrown: null });
    }
  }

  return failures;
}

/** 失敗したケースを、ファイルと行を辿れる形の文字列にまとめる。 */
export function formatGoldenFailures(failures: readonly GoldenFailure[], fileName: string): string {
  const header = `${fileName}: ${failures.length} 件のゴールデンテストが失敗しました。`;

  const details = failures.map(({ testCase, actual, thrown }) => {
    // 保留のケースが失敗に含まれるのは、通ってしまったときだけ（ADR-0019）。
    const outcome =
      testCase.pending !== null
        ? `実際  : ${actual}（"${PENDING_DIRECTIVE} ${testCase.pending}" の印を外してください）`
        : thrown === null
          ? `実際  : ${actual}`
          : `例外  : ${thrown}`;
    return [
      `${fileName}:${testCase.line}`,
      `  式    : ${testCase.source.split('\n').join('\n          ')}`,
      `  期待値: ${testCase.expected}`,
      `  ${outcome}`,
    ].join('\n');
  });

  return [header, ...details].join('\n\n');
}
