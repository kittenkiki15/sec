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
export type GoldenEvaluator = (source: string) => string;

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

function parseBlock(block: readonly SourceLine[], fileName: string): GoldenCase {
  const first = block[0];
  if (first === undefined) {
    throw new GoldenParseError(`${fileName}: 内部エラー: 空のケースを解析しようとしました。`, 0);
  }

  const expectIndex = block.findIndex((line) => line.text.trimStart().startsWith(EXPECT_PREFIX));
  if (expectIndex < 0) {
    throw new GoldenParseError(
      `${fileName}:${first.no}: 期待値がありません。ケースには "=>" で始まる行が必要です。`,
      first.no,
    );
  }

  const expectLine = block[expectIndex];
  if (expectIndex === 0 || expectLine === undefined) {
    throw new GoldenParseError(`${fileName}:${first.no}: "=>" の前に式がありません。`, first.no);
  }

  const source = block
    .slice(0, expectIndex)
    .map((line) => line.text)
    .join('\n')
    .trim();

  const head = expectLine.text.trimStart().slice(EXPECT_PREFIX.length);
  const rest = block.slice(expectIndex + 1).map((line) => line.text);
  const expected = [head, ...rest].join('\n').trim();

  if (expected === '') {
    throw new GoldenParseError(`${fileName}:${expectLine.no}: 期待値が空です。`, expectLine.no);
  }

  return { source, expected, line: first.no };
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
      actual = evaluate(testCase.source);
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
