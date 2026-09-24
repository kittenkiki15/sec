/**
 * `sec` のサブコマンド。**process に触れない純粋な関数**として書く。
 *
 * 出力先と終了コードを値として返すので、**起動せずにテストできる。**
 * process を触るのは `main.ts` だけで、そちらは配線しか持たない。
 *
 * **stdout に出すのは値の表記だけ**にしてある。診断や使い方を混ぜると、
 * `pnpm sec eval ...` の出力をそのまま値として受け取れなくなる。
 */

import { type Diagnostic, evaluateFormula, NotImplementedError, printValue } from '@sec/core/eval';
import { type CellAddress, printAddress } from '@sec/core/model';
import {
  exceedances,
  formatReport,
  type Measurement,
  measure,
  parseCells,
  scenarios,
} from './bench.ts';
import type { MacroOutcome, MacroRequest } from './macro.ts';
import { printSheetFile, readSheetFile, type SheetCells } from './sheet-file.ts';
import type { TimedOut } from './worker-host.ts';

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

/**
 * `sec` が process の外に触れる手段。**ファイルと Worker はここを通す。**
 * 差し替えれば `sec run` の判断を、ファイルも Worker も使わずに確かめられる。
 */
export interface CommandHost {
  /** ファイルを読む。**読めなければ投げる。** */
  readText(path: string): string;
  /** ファイルに書く。**書けなければ投げる。** */
  writeText(path: string, text: string): void;
  /** マクロを隔離した単位で走らせ、時間の上限を掛ける（ADR-0027）。 */
  runMacro(request: MacroRequest, timeoutMs: number): Promise<MacroOutcome | TimedOut>;
}

/** ホストを使わないサブコマンドのためのもの。`sec run` には `main.ts` が本物を渡す。 */
const NO_HOST: CommandHost = {
  readText: () => {
    throw new Error('このホストはファイルを読めません。');
  },
  writeText: () => {
    throw new Error('このホストはファイルを書けません。');
  },
  runMacro: () => Promise.reject(new Error('このホストはマクロを走らせられません。')),
};

/** 時間の上限の既定値（ミリ秒、ADR-0034）。 */
const DEFAULT_TIMEOUT_MS = 5000;

const USAGE = `使い方: sec <サブコマンド> [引数...]

  sec eval <式>       数式を 1 つ評価して結果を表示する
  sec run <マクロ> [オプション]
                      マクロのファイルを実行し、値と書き込んだセルを表示する
      --sheet <JSON>    開始前のシート（{"A1": "3", "B1": "=A1 * 2"} の形）
      --out <JSON>      実行後の空でない全セルを同じ形で書く
      --send <送信>     宣言部を持つ定義を起動する送信（'from: 1 to: 3'）
      --timeout <ms>    時間の上限（既定は ${DEFAULT_TIMEOUT_MS}）
  sec bench [セル数]  性能要件（N-1・N-2）を計測する（既定は 10000 セル）
  sec --help          この使い方を表示する

終了コード:
  0  値が出た / 計測がしきい値の中だった
  1  結果がエラー値だった（時間の上限を含む） / 計測がしきい値を超えた
  2  使い方が誤っている、またはまだ実装していない機能に当たった

例:
  sec eval '3 + 4 * 2'
  sec eval '#(1 2 3 4) inject: 0 into: [:a :b | a + b]'
  sec run sum.st --sheet in.json --out out.json --send 'from: 1 to: 3'
  sec bench
`;

/**
 * 引数を解釈して実行する。
 *
 * @param argv `sec` に渡された引数（実行ファイル名は含めない）
 * @param host ファイルと Worker に触れる手段。`sec run` だけが使う
 * @returns 出力と終了コード
 */
export async function runCommand(
  argv: readonly string[],
  host: CommandHost = NO_HOST,
): Promise<CommandResult> {
  const [subcommand, ...rest] = argv;

  if (subcommand === '--help' || subcommand === '-h') {
    return { stdout: USAGE, stderr: '', exitCode: EXIT.value };
  }
  if (subcommand === undefined) {
    return usageError('サブコマンドがありません。');
  }
  if (subcommand === 'eval') return runEval(rest);
  if (subcommand === 'bench') return runBench(rest);
  if (subcommand === 'run') return runMacroFile(rest, host);
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

  return benchResult(
    scenarios(parsed.cells).map((scenario) => measure(scenario)),
    parsed.cells,
  );
}

/**
 * 計測を出力と終了コードに直す。**CI が性能の回帰で落ちる経路そのもの。**
 *
 * **計測から切り離してあるのは、この変換を測らずに検査できるようにするため。**
 * 実時間に依存する経路に埋めてしまうと、しきい値を超えたときの振る舞いを
 * 固定する手段が無くなり、**壊れても「速いから緑」で気付けない。**
 *
 * @param measurements 各シナリオの計測
 * @param cells 測ったセル数。**しきい値を当てる規模かどうかの判断に要る**
 */
export function benchResult(measurements: readonly Measurement[], cells: number): CommandResult {
  const failures = exceedances(measurements, cells);

  return {
    // **レポートは超過していても出す。** どれだけ超えたかが分からないと直しようがない。
    stdout: formatReport(measurements, cells),
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

  return {
    // 表記は §0.3 の 1 つ（printValue）。ゴールデンテストの期待値と同じ字面になる。
    stdout: `${printValue(value)}\n`,
    stderr: diagnosticLine(diagnostic),
    exitCode: value.kind === 'error' ? EXIT.error : EXIT.value,
  };
}

/** `sec run` のオプション。**どれも 1 度だけ、値を 1 つ取る。** */
const RUN_OPTIONS = ['--sheet', '--out', '--send', '--timeout'] as const;
type RunOption = (typeof RUN_OPTIONS)[number];

/**
 * `sec run <マクロ> [--sheet <JSON>] [--out <JSON>] [--send <送信>] [--timeout <ms>]`。
 *
 * **stdout には値と確定した書き込みを出す**（利用者の選択、ADR-0034）。マクロの主な効果は
 * セルへの書き込みで、値だけでは何をしたかが見えない。書き込みは `B1 := 6` の形で、
 * ゴールデンテストのセルの指定（ADR-0009）と同じ区切りにした。
 */
async function runMacroFile(args: readonly string[], host: CommandHost): Promise<CommandResult> {
  const parsed = parseRunArguments(args);
  if ('error' in parsed) return usageError(parsed.error);
  const { macroPath, options } = parsed;

  const timeoutMs = parseTimeout(options.get('--timeout'));
  if (timeoutMs === null) {
    return usageError('--timeout は 1 以上の整数（ミリ秒）で指定してください。');
  }

  const source = readFileOrFail(host, macroPath);
  if (typeof source !== 'string') return source;

  let cells: SheetCells = [];
  const sheetPath = options.get('--sheet');
  if (sheetPath !== undefined) {
    const text = readFileOrFail(host, sheetPath);
    if (typeof text !== 'string') return text;
    const sheet = readSheetFile(text);
    if ('error' in sheet) return usageError(`${sheetPath}: ${sheet.error}`);
    cells = sheet.cells;
  }

  const send = options.get('--send') ?? null;
  const outcome = await host.runMacro({ source, cells, send }, timeoutMs);
  if (outcome.kind === 'invalidSend') {
    return usageError(`--send の "${send}" を 1 つの送信として読めません。`);
  }

  const result: CommandResult =
    outcome.kind === 'timedOut'
      ? {
          stdout: '#Timeout\n',
          // ステップ数の上限（§7.8）の #Timeout と見分けられるように、時間で打ち切ったことを言う。
          stderr: `時間の上限（${timeoutMs}ms）を超えたので打ち切りました。書き込みは反映していません。\n`,
          exitCode: EXIT.error,
        }
      : {
          stdout: `${outcome.value}\n${outcome.written.map(([address, content]) => `${printAssignment(address, content)}\n`).join('')}`,
          stderr: diagnosticLine(outcome.diagnostic),
          exitCode: outcome.failed ? EXIT.error : EXIT.value,
        };

  // 打ち切ったマクロは何も反映していないので、開始前のシートを書く。
  const outPath = options.get('--out');
  if (outPath !== undefined) {
    try {
      host.writeText(outPath, printSheetFile(outcome.kind === 'timedOut' ? cells : outcome.cells));
    } catch (error) {
      // **値は出す。** マクロは走り終えており、書けなかったのは出力先だけである。
      return {
        ...result,
        stderr: `${result.stderr}${outPath} に書けません（${(error as Error).message}）。\n`,
        exitCode: EXIT.usage,
      };
    }
  }
  return result;
}

/** 引数をマクロのパスとオプションに分ける。 */
function parseRunArguments(
  args: readonly string[],
): { macroPath: string; options: Map<RunOption, string> } | { error: string } {
  const positional: string[] = [];
  const options = new Map<RunOption, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? '';
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const option = RUN_OPTIONS.find((known) => known === arg);
    if (option === undefined) return { error: `"${arg}" というオプションはありません。` };
    const value = args[index + 1];
    if (value === undefined) return { error: `${option} に値がありません。` };
    // 2 度目で黙って上書きすると、どちらが効いたかが出力から分からない。
    if (options.has(option)) return { error: `${option} は 1 度だけ指定してください。` };
    options.set(option, value);
    index++;
  }

  const [macroPath, ...extra] = positional;
  if (macroPath === undefined) return { error: '実行するマクロのファイルがありません。' };
  if (extra.length > 0) {
    return {
      error: `マクロのファイルは 1 つだけ受け取ります（${positional.length} 個ありました）。`,
    };
  }
  return { macroPath, options };
}

/** `--timeout` の値。**省けば既定値、正の整数でなければ `null`。** */
function parseTimeout(text: string | undefined): number | null {
  if (text === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[0-9]+$/.test(text)) return null;
  const value = Number(text);
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

function readFileOrFail(host: CommandHost, path: string): string | CommandResult {
  try {
    return host.readText(path);
  } catch (error) {
    return usageError(`${path} を読めません（${(error as Error).message}）。`);
  }
}

/** 書き込みを `B1 := 6` の形にする。**空にしたセルは区切りだけ**——末尾の空白は見えない。 */
function printAssignment(address: CellAddress, content: string): string {
  return content === '' ? `${printAddress(address)} :=` : `${printAddress(address)} := ${content}`;
}

/** 位置と説明文は構文エラーにしか付かない（要件 F-8-3）。付かないものを 0:0 で埋めない。 */
function diagnosticLine(diagnostic: Diagnostic | undefined): string {
  return diagnostic === undefined
    ? ''
    : `${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}\n`;
}

/** 使い方の誤り。**理由を先に言ってから**使い方を出す。 */
function usageError(reason: string): CommandResult {
  return { stdout: '', stderr: `${reason}\n\n${USAGE}`, exitCode: EXIT.usage };
}
