/**
 * 性能要件（N-1・N-2）の計測。**回帰を数字ではなく終了コードで検出する段。**
 *
 * 開発方針のリスク表が「性能要件が終盤に破綻」への対策として
 * **「`sec bench` を M3 の時点で作り、CI で回帰を検出する」**としている。
 * 検出が成り立つには機械的な合否が要るので、**しきい値を超えたら終了コードで落とす。**
 *
 * | 要件 | 内容 |
 * | --- | --- |
 * | N-1 | 10,000 セル・平均依存度 3 のブックで、1 セル変更時の増分再計算を 100ms 以内 |
 * | N-2 | 10,000 セルのフル再計算を 1 秒以内 |
 *
 * **測る形は 2 つある。** 段階 6 の時点の手元の計測は範囲を含まない形しか見ておらず、
 * **範囲を集計するセルは矩形の広さだけ読みを記録する**（ADR-0024）ので、そこが未計測だった。
 *
 * **合否判定を持つのでテストを先に書いている。** ADR-0004 の「性能ベンチマーク」例外は
 * 合否判定が無いものに限る。**断言しないのは計測値そのものだけ**で、シナリオの形・
 * 中央値の採り方・しきい値の当て方はいずれも振る舞いとして固定してある。
 */

import { type CellAddress, columnAt, LiveSheet } from '@sec/core/model';

/** 要件 N-1・N-2 が数字を定めている規模。 */
export const REQUIRED_CELLS = 10_000;

/**
 * 測れるセル数の上限。**要件の規模の 10 倍で、実測で決めた値。**
 *
 * **「終端に到達する」ことと「現実の時間で終わる」ことは別である。** 数として
 * 表せる上限（`Number.MAX_SAFE_INTEGER`）まで受けると、`index += 1` が終端に届く
 * ことは保証されるが、**シナリオはそのセル数だけ内容を作る**ので、ヒープを使い切るか
 * 何年も終わらない。**利用者は誤りを言われないまま固まったプロセスを見る。**
 *
 * 手元の計測（Node 22）:
 *
 * | セル数 | 全体の所要 | フル再計算（範囲集計） |
 * | --- | --- | --- |
 * | 10,000（要件の規模） | 約 2.5 秒 | 91ms |
 * | 100,000 | 約 45 秒 | 3.8 秒 |
 * | 500,000 | **3 分で終わらない** | — |
 *
 * **上限は「探索に使えるうちで最大」という基準で採った。** 100,000 は 45 秒で返るが、
 * その 5 倍は返ってこない。
 */
export const MAX_CELLS = 100_000;

/** 性能要件のしきい値（ミリ秒）。**要件定義書 §6 の数字をそのまま写したもの。** */
export const LIMIT = {
  /** 要件 N-2: 10,000 セルのフル再計算を 1 秒以内。 */
  fullMs: 1000,
  /** 要件 N-1: 1 セル変更時の増分再計算を 100ms 以内。 */
  incrementalMs: 100,
} as const;

/**
 * スカラ鎖のシナリオの列数。**行の中に依存を閉じるための幅。**
 *
 * 広いほど 1 セル変更の下流が長くなる。**要件 N-1 の「1 セル変更時の増分」を測る以上、
 * 下流がブック全体になってはならない**（それはフル再計算を測っているのと同じである）。
 * 100 列なら下流は 100 件に収まる。
 */
const CHAIN_COLUMNS = 100;

/** スカラ鎖の基本の依存度。**数式セルはこの数だけ左を読む。** */
const CHAIN_DEGREE = 3;

/**
 * 行の末尾側の数式に足す参照の数。**ブック全体の平均依存度をちょうど 3 にするためのもの。**
 *
 * **要件 N-1 の「平均依存度 3」はブック全体の値である**（AI レビューの指摘、#59）。
 * 行の先頭 `CHAIN_DEGREE` 列は種となる定数で依存を持たないので、**1 行あたり
 * `CHAIN_DEGREE × CHAIN_DEGREE` 本の辺が足りない。** そのぶんを末尾側の数式に
 * 1 本ずつ配ると、`(W - 3) × 3 + 9 = 3W` で平均がちょうど 3 になる。
 *
 * **依存度を一様に保ったままでは 3 に届かない**（`3(W-3)/W < 3`）。
 * **揃えることを諦めれば届く。** 要件が定めているのは平均であって、
 * 各セルが同じ数だけ読むことではない——実際の表もそうである。
 */
const CHAIN_EXTRA_EDGES = CHAIN_DEGREE * CHAIN_DEGREE;

/** 範囲集計のシナリオで、1 つの集計セルが読む窓の広さ。 */
const AGGREGATE_WINDOW = 10;

/**
 * 計測するシート。**内容と、増分再計算で書き換えるセルだけを持つ**（計測は `measure`）。
 *
 * 形を値として取り出せるようにしてあるのは、**シートが本当に狙った形になっているかを
 * 計測なしで検査できるようにするため。** 番地を組み立て損ねた形は `#Ref` を並べるだけの
 * シートになり、速いが何も測っていない。
 */
export interface Scenario {
  /** レポートに出す名前。 */
  readonly name: string;
  /** 何を測る形なのか。**数字だけでは形の妥当性を判断できない。** */
  readonly description: string;
  /** シートに置く内容。 */
  readonly contents: readonly (readonly [CellAddress, string])[];
  /** 増分再計算で書き換えるセル。**内容は繰り返しのたびに順に使う**（毎回変わるように）。 */
  readonly edit: {
    readonly address: CellAddress;
    readonly contents: readonly string[];
  };
}

/** 列と行の番号から番地を組み立てる。**どちらも 1 始まり。** */
function cellAt(column: number, row: number): CellAddress {
  return { column: columnAt(BigInt(column)), row: BigInt(row) };
}

/** 番地の綴り。数式の原文を組み立てるのに使う。 */
function spell(column: number, row: number): string {
  return `${columnAt(BigInt(column))}${row}`;
}

/**
 * スカラ鎖のシナリオ（要件 N-1 の字面どおりの形）。
 *
 * **100 列を 1 行とし、左の 3 列を定数、残りを「左 3 つのセルの和」にする。**
 * **行の末尾 9 列だけは行の先頭も読む**（`CHAIN_EXTRA_EDGES`）ので、
 * **ブック全体の平均依存度がちょうど 3 になる**（要件 N-1 の字面）。
 *
 * **依存が行の中に閉じている。** 1 セル変更したときの下流が同じ行の 97 セルに限られ、
 * **増分再計算がシート全体を触っていないことがそのまま時間に出る**（要件 N-1 の眼目）。
 */
export function scalarChain(cells: number): Scenario {
  const contents: (readonly [CellAddress, string])[] = [];

  for (let index = 0; index < cells; index += 1) {
    const column = (index % CHAIN_COLUMNS) + 1;
    const row = Math.floor(index / CHAIN_COLUMNS) + 1;

    if (column <= CHAIN_DEGREE) {
      // **定数は全部違う値にする。** 同じ値を並べると、値の比較で下流を止める実装
      // （まだ入っていない）が入ったときに、測っているものが黙って変わる。
      contents.push([cellAt(column, row), String(index + 1)]);
      continue;
    }

    const referenced = Array.from({ length: CHAIN_DEGREE }, (_, back) =>
      spell(column - CHAIN_DEGREE + back, row),
    );
    // **末尾側の数式が、定数セルの持てなかった辺を肩代わりする。** 読む相手は行の
    // 先頭（1 列目）で、**既に間接的に依存しているセル**なので下流の形は変わらない。
    if (column > CHAIN_COLUMNS - CHAIN_EXTRA_EDGES) referenced.push(spell(1, row));
    contents.push([cellAt(column, row), `=${referenced.join(' + ')}`]);
  }

  return {
    name: 'スカラ鎖',
    description: `${CHAIN_COLUMNS} 列を 1 行とし、左 ${CHAIN_DEGREE} 列は定数、残りは左 ${CHAIN_DEGREE} つの和（ブック全体の平均依存度 ${CHAIN_DEGREE}、要件 N-1）`,
    contents,
    // 行の先頭。**この行の数式セルすべての上流**にあたる。
    // **`'2'` から始める。** A1 の初期値が `'1'` なので、1 回目から必ず値が変わる。
    edit: { address: cellAt(1, 1), contents: ['2', '1'] },
  };
}

/**
 * 範囲集計のシナリオ（矩形の広さが効く形）。
 *
 * **A 列に定数を並べ、B 列が 10 セルの窓を集計し、C1 が A 列全体を総計する。**
 * 無効化の索引は読んだ番地を記録するので（ADR-0024）、**総計のセルは A 列の数だけ
 * 辺を張る。** 段階 6 の手元の計測が見ていなかったのがこの費用である。
 *
 * **1 セル変更の下流は窓の集計と総計の 2 つ**だが、総計は列全体を読み直す。
 * 増分再計算の時間に矩形の広さが出るのはそこ。
 */
export function rangeAggregate(cells: number): Scenario {
  const contents: (readonly [CellAddress, string])[] = [];

  // **総計のセルの分を 1 つ残す。** 残さないと最後に置く場所が無くなる。
  // セルが 1 つしか無いときは総計が読む相手がいないので、定数だけにする。
  const budget = cells >= 2 ? cells - 1 : cells;

  let constants = 0;
  let aggregates = 0;
  while (contents.length < budget) {
    constants += 1;
    contents.push([cellAt(1, constants), String(constants)]);

    if (constants % AGGREGATE_WINDOW === 0 && contents.length < budget) {
      aggregates += 1;
      const first = (aggregates - 1) * AGGREGATE_WINDOW + 1;
      const last = aggregates * AGGREGATE_WINDOW;
      contents.push([cellAt(2, aggregates), `=A${first}..A${last} sum`]);
    }
  }

  if (cells >= 2) contents.push([cellAt(3, 1), `=A1..A${constants} sum`]);

  return {
    name: '範囲集計',
    description: `A 列の定数を ${AGGREGATE_WINDOW} セルの窓で集計し、C1 が A 列全体を総計する`,
    contents,
    // A1 の初期値が `'1'` なので、**1 回目から必ず値が変わる**順にする。
    edit: { address: cellAt(1, 1), contents: ['2', '1'] },
  };
}

/** 測る形をすべて。**順序はレポートに出る順序。** */
export function scenarios(cells: number): readonly Scenario[] {
  return [scalarChain(cells), rangeAggregate(cells)];
}

/** 1 つのシナリオの計測。**時間はいずれも中央値**（`measure`）。 */
export interface Measurement {
  readonly scenario: string;
  /** 何を測った形なのか（`Scenario.description`）。**レポートで数字の隣に置く。** */
  readonly description: string;
  /** シートのセル数。 */
  readonly cells: number;
  /** フル再計算（要件 N-2）。 */
  readonly fullMs: number;
  /** 1 セル変更の増分再計算（要件 N-1）。 */
  readonly incrementalMs: number;
  /** 増分で計算し直したセルの数。**時間だけでは形の妥当性を判断できない。** */
  readonly recalculated: number;
}

export interface MeasureOptions {
  /** 時刻（ミリ秒）。既定は `performance.now`。**差し替えられるのはテストのため。** */
  readonly now?: () => number;
  /** フル再計算を測る回数。 */
  readonly fullRuns?: number;
  /** 増分再計算を測る回数。 */
  readonly incrementalRuns?: number;
}

/** フル再計算の既定の回数。**1 回が 0.1 秒の桁**なので、数回で十分。 */
const FULL_RUNS = 5;

/** 増分再計算の既定の回数。**1 回がミリ秒に満たない**ので、多めに取って中央値を採る。 */
const INCREMENTAL_RUNS = 101;

/**
 * 並べ替えて真ん中の値。
 *
 * **平均ではなく中央値を採る。** 計測は GC や OS の割り込みで上へ跳ねるので、
 * 平均だと 1 回の外れ値がそのまま報告値を動かす。
 * **偶数個なら小さい側。** 2 つの平均は、実際には 1 度も測っていない値になる。
 */
function median(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * シナリオを計測する。
 *
 * **1 回目は捨てる。** JIT が温まる前の数字は後の実行と比べられず、
 * 1 回目だけを見ると回帰ではなく暖機を測ることになる。
 */
export function measure(scenario: Scenario, options: MeasureOptions = {}): Measurement {
  const now = options.now ?? (() => performance.now());
  const fullRuns = options.fullRuns ?? FULL_RUNS;
  const incrementalRuns = options.incrementalRuns ?? INCREMENTAL_RUNS;

  // 暖機。**時計は呼ばない**——捨てる実行の時間には意味がない。
  let live = new LiveSheet(scenario.contents);

  const full: number[] = [];
  for (let run = 0; run < fullRuns; run += 1) {
    const started = now();
    // **作ることがフル再計算である**（`LiveSheet` は構築時にシート全体を計算する）。
    live = new LiveSheet(scenario.contents);
    full.push(now() - started);
  }

  const incremental: number[] = [];
  let recalculated = 0;
  for (let run = 0; run < incrementalRuns; run += 1) {
    // **毎回違う内容を置く。** 同じ内容を置き続けると、内容の変化を見て省く実装が
    // 入ったときに測っているものが変わる。
    const content = scenario.edit.contents[run % scenario.edit.contents.length] ?? '';
    const started = now();
    const touched = live.put(scenario.edit.address, content);
    incremental.push(now() - started);
    recalculated = touched.length;
  }

  return {
    scenario: scenario.name,
    description: scenario.description,
    cells: scenario.contents.length,
    fullMs: median(full),
    incrementalMs: median(incremental),
    recalculated,
  };
}

/**
 * しきい値を超えた計測を挙げる。**空なら合格。**
 *
 * **要件が定めているのは 10,000 セルの数字だけである。** 別の規模に当てると
 * 根拠の無い合否になるので、**セル数が違うときは何も言わない**——
 * 探索のために規模を変えた実行が、しきい値の側の都合で落ちることもない。
 */
export function exceedances(
  measurements: readonly Measurement[],
  cells: number,
): readonly string[] {
  if (cells !== REQUIRED_CELLS) return [];

  const failures: string[] = [];
  for (const measured of measurements) {
    if (measured.fullMs > LIMIT.fullMs) {
      failures.push(
        `${measured.scenario}: フル再計算が ${millis(measured.fullMs)} で、` +
          `要件 N-2 の上限 ${LIMIT.fullMs}ms を超えている`,
      );
    }
    if (measured.incrementalMs > LIMIT.incrementalMs) {
      failures.push(
        `${measured.scenario}: 1 セル変更の増分が ${millis(measured.incrementalMs)} で、` +
          `要件 N-1 の上限 ${LIMIT.incrementalMs}ms を超えている`,
      );
    }
  }
  return failures;
}

/** 時間の表記。**桁を揃える**ので、実行をまたいで目で比べられる。 */
function millis(value: number): string {
  return `${value.toFixed(3)}ms`;
}

/**
 * 計測のレポート。
 *
 * **形の説明と、計算し直したセルの数も出す。** 時間だけを並べると、シートが狙った形に
 * なっていないまま「速い」と読めてしまう。
 */
export function formatReport(measurements: readonly Measurement[], cells: number): string {
  const lines = [`sec bench — ${cells} セル`, ''];

  for (const measured of measurements) {
    lines.push(
      `[${measured.scenario}] ${measured.description}`,
      `  フル再計算: ${millis(measured.fullMs)}（要件 N-2 の上限 ${LIMIT.fullMs}ms）`,
      `  1 セル変更の増分: ${millis(measured.incrementalMs)}` +
        `（要件 N-1 の上限 ${LIMIT.incrementalMs}ms、計算し直したセル ${measured.recalculated} 件）`,
      '',
    );
  }

  lines.push(
    cells === REQUIRED_CELLS
      ? '判定は要件 N-1・N-2 のしきい値に対して行う。'
      : `判定はしない。要件 N-1・N-2 が数字を定めているのは ${REQUIRED_CELLS} セルの規模だけである。`,
    '',
  );

  return lines.join('\n');
}

/** 引数の解釈の結果。**読めた数か、読めなかった理由。** */
export type ParsedCells = { readonly cells: number } | { readonly error: string };

/**
 * `sec bench [セル数]` の引数を読む。
 *
 * **読めない綴りを黙って既定値に倒さない。** 打ち間違いが「測れた」ことになると、
 * CI が何を測ったのか分からないまま緑になる。
 */
export function parseCells(args: readonly string[]): ParsedCells {
  const [spelling, ...extra] = args;

  if (extra.length > 0) {
    return { error: `セル数は 1 つだけ受け取ります（${args.length} 個ありました）。` };
  }
  if (spelling === undefined) return { cells: REQUIRED_CELLS };
  if (!/^[0-9]+$/.test(spelling)) {
    return { error: `セル数として "${spelling}" を読めません。正の整数を渡してください。` };
  }

  const cells = Number(spelling);
  if (cells <= 0) return { error: 'セル数は 1 以上にしてください。' };

  // **上限の検査を落とさない。** 倍精度に収まらない綴りは `Infinity` になり、
  // `Infinity <= 0` は false なので上の検査を通ってしまう。
  if (cells > MAX_CELLS) {
    return { error: `セル数 "${spelling}" は大きすぎます。${MAX_CELLS} までです。` };
  }
  return { cells };
}
