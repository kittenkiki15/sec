/**
 * `sec` のサブコマンド。**process に触れない純粋な関数**として書く。
 *
 * 出力先と終了コードを値として返すので、**起動せずにテストできる。**
 * process を触るのは `main.ts` だけで、そちらは配線しか持たない。
 *
 * **stdout に出すのは値の表記だけ**にしてある。診断や使い方を混ぜると、
 * `pnpm sec eval ...` の出力をそのまま値として受け取れなくなる。
 */

import { evaluateFormula, NotImplementedError, printValue } from '@sec/core/eval';
import { exceedances, formatReport, measure, parseCells, scenarios } from './bench.ts';

/** `sec` の 1 回の実行が生む出力。**process には触れない**ので、そのままテストできる。 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/**
 * 終了コード。**エラー値でも 1 にする。**
 *
 * エラーは値の一種だが（要件 F-8-1）、Bash から `&&` でつないだときに失敗が
 * 伝わってほしい。開発中のフィードバックは CLI で回すので（開発方針）、
 * **Claude Code が出力の字面を読まずに正誤を判定できる**方が速い。
 */
const EXIT = {
  /** 値が出た。 */
  value: 0,
  /** 結果がエラー値だった、または計測が性能要件のしきい値を超えた。 */
  error: 1,
  /** 使い方が誤っている、またはまだ実装していない機能に当たった。 */
  usage: 2,
} as const;

const USAGE = `使い方: sec <サブコマンド> [引数...]

  sec eval <式>       数式を 1 つ評価して結果を表示する
  sec bench [セル数]  性能要件（N-1・N-2）を計測する（既定は 10000 セル）
  sec --help          この使い方を表示する

終了コード:
  0  値が出た / 計測がしきい値の中だった
  1  結果がエラー値だった / 計測がしきい値を超えた
  2  使い方が誤っている、またはまだ実装していない機能に当たった

例:
  sec eval '3 + 4 * 2'
  sec eval '#(1 2 3 4) inject: 0 into: [:a :b | a + b]'
  sec bench
`;

/**
 * 引数を解釈して実行する。
 *
 * @param argv `sec` に渡された引数（実行ファイル名は含めない）
 * @returns 出力と終了コード
 */
export function runCommand(argv: readonly string[]): CommandResult {
  const [subcommand, ...rest] = argv;

  if (subcommand === '--help' || subcommand === '-h') {
    return { stdout: USAGE, stderr: '', exitCode: EXIT.value };
  }
  if (subcommand === undefined) {
    return usageError('サブコマンドがありません。');
  }
  if (subcommand === 'eval') return runEval(rest);
  if (subcommand === 'bench') return runBench(rest);
  return usageError(`"${subcommand}" というサブコマンドはありません。`);
}

/**
 * `sec bench [セル数]`。
 *
 * **合否を終了コードに出す。** 開発方針のリスク表が言う「CI で回帰を検出する」は、
 * ログの数字を人間が読む形では成り立たない。判断の中身は `bench.ts` にある。
 */
function runBench(args: readonly string[]): CommandResult {
  const parsed = parseCells(args);
  if ('error' in parsed) return usageError(parsed.error);

  const measurements = scenarios(parsed.cells).map((scenario) => measure(scenario));
  const failures = exceedances(measurements, parsed.cells);

  return {
    // **レポートは超過していても出す。** どれだけ超えたかが分からないと直しようがない。
    stdout: formatReport(measurements, parsed.cells),
    stderr: failures.map((failure) => `${failure}\n`).join(''),
    exitCode: failures.length === 0 ? EXIT.value : EXIT.error,
  };
}

/**
 * `sec eval <式>`。
 *
 * **式は 1 つだけ受ける。** 黙って 1 つ目を評価すると、シェルの引用符を書き損ねて
 * 式が分かれたときに、別の式の結果を正しい答えとして受け取ってしまう。
 */
function runEval(args: readonly string[]): CommandResult {
  const [source, ...extra] = args;
  if (source === undefined) {
    return usageError('評価する式がありません。');
  }
  if (extra.length > 0) {
    return usageError(
      `式は 1 つだけ受け取ります（${args.length} 個ありました）。` +
        '式全体を引用符で囲んでください。',
    );
  }

  let evaluation: ReturnType<typeof evaluateFormula>;
  try {
    evaluation = evaluateFormula(source);
  } catch (error) {
    // **まだ実装していないことは仕様上のエラーではない**（数式セルは M3 段階 5、
    // マクロは M4）。#Ref などの値に化けさせると、実装済みかどうかが出力から読み取れない。
    // **いまは引数の式から到達できる未実装が無い**（`command.test.ts`）。
    if (error instanceof NotImplementedError) {
      return { stdout: '', stderr: `${error.message}\n`, exitCode: EXIT.usage };
    }
    throw error;
  }

  const { value, diagnostic } = evaluation;
  // 位置と説明文は構文エラーにしか付かない（要件 F-8-3）。付かないものを 0:0 で埋めない。
  const stderr =
    diagnostic === undefined
      ? ''
      : `${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n`;

  return {
    // 表記は §0.3 の 1 つ（printValue）。ゴールデンテストの期待値と同じ字面になる。
    stdout: `${printValue(value)}\n`,
    stderr,
    exitCode: value.kind === 'error' ? EXIT.error : EXIT.value,
  };
}

/** 使い方の誤り。**理由を先に言ってから**使い方を出す。 */
function usageError(reason: string): CommandResult {
  return { stdout: '', stderr: `${reason}\n\n${USAGE}`, exitCode: EXIT.usage };
}
