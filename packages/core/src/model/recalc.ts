/**
 * 再計算（要件 F-4-1〜3）。**シートの原文からセルの値を出す段。**
 *
 * シートは原文しか持たない（`sheet.ts`）。定数セルの値は内容の解釈（§4.4）だけで決まるが、
 * **数式セルの値は他のセルの値に依存する**ので、読む順序が要る。
 *
 * 方式は [ADR-0023](../../../../docs/adr/0023-dependency-extraction.md)。
 *
 * - **順序は静的な依存グラフが決める**（F-4-1、F-4-2）。数式の木から読みうるセルを集め、
 *   トポロジカル順序に並べてから評価する。
 * - **正しさは遅延と進行中の印が持つ**（F-4-3）。値は求められたときに求め、
 *   **求めている最中のセルを読み直したら参照が巡っている。** 静的な抽出が取りこぼした
 *   読み（端が式の範囲など）も、この安全網が拾う。
 *
 * **順序が要るのは深さのためである。** 安全網だけでも値は正しく出るが、参照の鎖の長さが
 * そのまま再帰の深さになる。先に浅い方から埋めておけば、鎖が長くてもスタックが尽きない。
 *
 * **増分再計算（F-4-2）は [ADR-0024](../../../../docs/adr/0024-incremental-invalidation.md)。**
 * どのセルを計算し直すかは、**評価中に実際に読んだ番地の記録**から決める（`invalidation.ts`）。
 * 入口は `LiveSheet`（`live-sheet.ts`）で、書き込みと無効化を兼ねる。
 * **値を捨てる（`invalidate`）と計算する（`settle`）は分けてある**（ADR-0027 の案 C）。
 * マクロの書き込みは捨てるだけにし、成功か失敗かが決まってから計算する。
 */

import { evaluateParsedFormula, type ParsedFormula, parseFormulaOrFail } from '../eval/evaluate.ts';
import { type CellValues, type HeldValue, heldValue } from '../eval/value.ts';
import {
  type CellAddress,
  columnAt,
  columnIndex,
  compareColumns,
  isResolvable,
  printAddress,
} from './address.ts';
import { readContent } from './content.ts';
import { type Dependency, type DependencyExtractor, staticDependencies } from './dependencies.ts';
import {
  type InvalidationIndex,
  type InvalidationIndexFactory,
  recordedReads,
} from './invalidation.ts';
import type { Sheet } from './sheet.ts';

/** 空セルの値（[ADR-0010](../../../../docs/adr/0010-empty-cell-value.md)）。 */
const NIL: HeldValue = { kind: 'nil' };

/** 参照が巡っているセルの値（§4.2、要件 F-4-3）。 */
const CIRCULAR: HeldValue = { kind: 'error', error: 'Circular' };

/** 数式を持つセル。**木と依存は内容が変わったときにだけ作る**（評価のたびに作らない）。 */
interface FormulaCell {
  readonly address: CellAddress;
  readonly parsed: ParsedFormula;
  /** 静的に抽出した依存（要件 F-4-1）。**順序を決めるのに使う。** */
  readonly dependencies: readonly Dependency[];
}

export interface RecalculationOptions {
  /**
   * 依存の抽出（要件 F-4-1）。既定は静的な抽出（`staticDependencies`）。
   *
   * **差し替えられるのは、抽出が順序しか決めないからである**（ADR-0023）。
   * 何を返しても値は変わらず、変わるのは評価の順序と再帰の深さだけなので、
   * 段階 7 の `sec bench` が方式を測って選べる。
   */
  readonly dependencies?: DependencyExtractor;

  /**
   * 無効化の索引（要件 F-4-2）。既定は実際に読んだ番地の記録（`recordedReads`）。
   *
   * **差し替えられるのは、索引が「計算し直す範囲」しか決めないからである**（ADR-0024）。
   * 多めに汚す索引でも値は変わらず、変わるのは計算し直すセルの数だけである。
   */
  readonly invalidation?: InvalidationIndexFactory;
}

/**
 * シートの値を保つもの。**内容が変わったセルを伝えると、下流だけを計算し直す**（要件 F-4-2）。
 *
 * **変更を伝える相手は `LiveSheet` だけである。** シートへの書き込みと無効化は対で
 * 起きなければならず（伝え忘れた値は古いまま残る）、**対にする責任を 1 箇所へ集めてある。**
 * 1 度きりでよい呼び出し側は、下の `recalculate` を使う。
 */
export class Recalculation {
  readonly #sheet: Sheet;
  readonly #extract: DependencyExtractor;
  readonly #index: InvalidationIndex;

  /** 数式を持つセル。キーは正規化した番地の綴り（ADR-0020）。 */
  readonly #formulas = new Map<string, FormulaCell>();

  /** 求まった値。**同じセルの値は 1 つである**（決定性、要件 F-4-4）。 */
  readonly #values = new Map<string, HeldValue>();

  /** 値を捨てたまま `settle` を待つセル（ADR-0027 の案 C）。キーは番地の綴り。 */
  readonly #unsettled = new Map<string, CellAddress>();

  /** 値を求めている最中のセル。**読み直したら参照が巡っている**（要件 F-4-3）。 */
  readonly #evaluating = new Set<string>();

  /**
   * 評価中のセルが読んだ番地（要件 F-4-2）。**セルの評価は入れ子になるので積む。**
   *
   * **枠が無いときの読みは誰のものでもない。** `sec eval` の式のように、
   * セルの外から評価されたものがそれで、記録する相手がいない。
   */
  readonly #reads: CellAddress[][] = [];

  /** **作った時点でシート全体を再計算する**（フル再計算、要件 F-4-2）。 */
  constructor(sheet: Sheet, options: RecalculationOptions = {}) {
    this.#sheet = sheet;
    this.#extract = options.dependencies ?? staticDependencies;
    this.#index = (options.invalidation ?? recordedReads)();

    for (const address of this.#sheet.addresses()) this.#refreshFormula(address);
    this.#evaluate(
      this.#formulas,
      [...this.#formulas.values()].map((cell) => cell.address),
    );
  }

  /** 番地からそのセルが保持する値を答える（§4.2）。**評価器にそのまま渡せる形。** */
  readonly values: CellValues = (address) => {
    // **評価の枠の外からの読みだけが、捨てたままの上流を浅い方から埋める。** 枠の中の読みは
    // この読みの上流を辿っている最中なので、そこで順序を組み直すと同じ仕事を繰り返す。
    if (this.#reads.length === 0) this.#settleUpstreamOf(address);
    return this.#valueAt(address);
  };

  /**
   * 内容の変わったセルを伝え、**下流の値を捨てる。計算はしない**（ADR-0027 の案 C）。
   *
   * 捨てたセルは読まれたときにその場で計算され、残りは `settle` がまとめて計算する。
   * **何度書いても下流を計算し直すのは、読まれた分と最後の 1 回だけ**で済む。
   * **シートへの書き込みはこのメソッドの外で済んでいる**（`LiveSheet`）。
   *
   * @param changed 内容の変わったセルの番地
   */
  invalidate(changed: CellAddress): void {
    // **木を作り直すのは変わったセルだけ。** 他のセルの原文は動いていない。
    this.#refreshFormula(changed);

    // **捨てる前に集める。** 閉包は今の記録を辿るので、先に忘れると下流を見失う。
    // 捨てたままのセルは記録も持たないので辿れないが、値が無いので捨て直す必要も無い。
    for (const [key, cell] of this.#dirtyFrom(changed)) {
      this.#values.delete(key);
      this.#index.forget(cell);
      this.#unsettled.set(key, cell);
    }
  }

  /**
   * 捨てたままのセルをまとめて計算する（要件 F-4-2）。
   *
   * @returns 前の `settle` から後に値を捨てたセルの番地。**途中で読まれて計算済みのものも含む**
   *   ——グリッドの描き直し（要件 F-7）が要る範囲なので、いつ計算したかを問わない
   */
  settle(): readonly CellAddress[] {
    const formulas = new Map<string, FormulaCell>();
    for (const key of this.#unsettled.keys()) {
      // 読まれて値を持ったセルは、順序を組む相手にならない（下記 `#evaluate`）。
      if (this.#values.has(key)) continue;
      const formula = this.#formulas.get(key);
      if (formula !== undefined) formulas.set(key, formula);
    }

    const settled = [...this.#unsettled.values()];
    this.#evaluate(formulas, settled);
    // **計算し終えてから忘れる。** 途中で例外が抜けたら、次の `settle` がまた拾う。
    this.#unsettled.clear();
    return settled;
  }

  /**
   * 捨てたままのセルを読む前に、**その上流の捨てたままの数式セルを浅い方から計算する。**
   *
   * 読まれたセルだけを計算する（ADR-0027 の案 C）と、上流へ潜って評価することになり、
   * **鎖の長さがそのまま再帰の深さになる。** 構築と `settle` がトポロジカル順序で回すのと
   * 同じ理由で、ここでも順序を組む。**読まれたセルに届かない枝は計算しない。**
   *
   * 上流は静的な依存で辿る。取りこぼした読みがあっても値は安全網が正す（ADR-0023）。
   */
  #settleUpstreamOf(address: CellAddress): void {
    const key = printAddress(address);
    const start = this.#uncomputedFormula(key);
    // 計算済みのセルと定数セルは、上流へ潜らない。
    if (start === undefined) return;

    // **読まれたセルの依存から辿る。** 捨てたままのセルを全部見ると、読まない枝の数だけ
    // 読むたびに費用がかかり、枝を順に読むマクロでは読む回数との積になる。
    const upstream = new Map<string, FormulaCell>([[key, start]]);
    // **先頭から取り出すのに `shift` を使わない。** 並びが長いほど費用が嵩む。
    const queue = [start];
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index];
      if (cell === undefined) continue;
      for (const [precedent, formula] of this.#uncomputedPrecedentsOf(cell.dependencies)) {
        if (upstream.has(precedent)) continue;
        upstream.set(precedent, formula);
        queue.push(formula);
      }
    }

    for (const cell of topologicalOrder(upstream)) this.#valueAt(cell.address);
  }

  /** 値を捨てたまま、まだ計算していない数式セル。**値を持つセルは辺を張る相手にならない。** */
  #uncomputedFormula(key: string): FormulaCell | undefined {
    if (!this.#unsettled.has(key) || this.#values.has(key)) return undefined;
    return this.#formulas.get(key);
  }

  /** 依存のうち、まだ計算していない数式セル（綴りと数式の組）。 */
  #uncomputedPrecedentsOf(
    dependencies: readonly Dependency[],
  ): Iterable<readonly [string, FormulaCell]> {
    const found = new Map<string, FormulaCell>();
    const note = (key: string): void => {
      const formula = this.#uncomputedFormula(key);
      if (formula !== undefined) found.set(key, formula);
    };

    for (const dependency of dependencies) {
      if (dependency.kind === 'cell') {
        note(printAddress(dependency.address));
        continue;
      }
      // **矩形は小さい方から見る。** 中のセルを数え上げる費用は矩形の大きさで、
      // 捨てたセルが中にあるかを見る費用は捨てたセルの数である（`A1..A1000000` もありうる）。
      if (areaOf(dependency) <= BigInt(this.#unsettled.size)) {
        for (const cell of cellsInside(dependency)) note(printAddress(cell));
      } else {
        for (const [key, cell] of this.#unsettled) if (isInside(dependency, cell)) note(key);
      }
    }
    return found;
  }

  /**
   * 数式セルをトポロジカル順序で評価し、残りを埋める。
   *
   * @param formulas 順序を組む対象。**増分では汚れたセルだけ**——汚れていないセルは
   *   既に値を持っているので、辺を張る相手にならない
   * @param rest 順序に載らなかったセルも含めて、値を持たせるべき番地
   */
  #evaluate(formulas: ReadonlyMap<string, FormulaCell>, rest: readonly CellAddress[]): void {
    // **トポロジカル順序で回す**（要件 F-4-2）。依存の側が先に値を持つので、
    // 鎖がどれだけ長くても評価の入れ子は 1 段で済む。
    for (const cell of topologicalOrder(formulas)) this.#valueAt(cell.address);

    // **順序に載らなかったセルもここで値を持つ。** 載らないのは循環に関わるセル
    // （と、静的な抽出がそう見たセル）で、値は安全網が決める。定数セルもここで埋まる。
    for (const address of rest) this.#valueAt(address);
  }

  /** 変更されたセルと、記録した読みを辿って届く下流（要件 F-4-2）。 */
  #dirtyFrom(changed: CellAddress): ReadonlyMap<string, CellAddress> {
    const dirty = new Map<string, CellAddress>([[printAddress(changed), changed]]);

    // **先頭から取り出すのに `shift` を使わない。** 並びが長いほど費用が嵩む。
    const queue = [changed];
    for (let index = 0; index < queue.length; index += 1) {
      const cell = queue[index];
      if (cell === undefined) continue;

      for (const reader of this.#index.readersOf(cell)) {
        const key = printAddress(reader);
        if (dirty.has(key)) continue;
        dirty.set(key, reader);
        queue.push(reader);
      }
    }

    return dirty;
  }

  /** セルの内容を読み直し、数式なら木と依存を作る。数式でなくなったなら捨てる。 */
  #refreshFormula(address: CellAddress): void {
    const key = printAddress(address);
    const content = readContent(this.#sheet.contentAt(address));
    if (content.kind !== 'formula') {
      this.#formulas.delete(key);
      return;
    }
    this.#parseFormula(address, key, content.source);
  }

  /** 数式の原文から木と依存を作り、覚える。**同じ木を抽出と評価の両方で使う。** */
  #parseFormula(address: CellAddress, key: string, source: string): FormulaCell {
    const parsed = parseFormulaOrFail(source);
    const cell: FormulaCell = {
      address,
      parsed,
      // 読めなかった数式は何にも依存しない。値は `#Syntax` で、他のセルを読まない。
      dependencies: parsed.kind === 'parsed' ? this.#extract(parsed.tree) : [],
    };
    this.#formulas.set(key, cell);
    return cell;
  }

  #valueAt(address: CellAddress): HeldValue {
    // 解決できない番地に値は無い。§4.2 が先に `#Ref` を返すので、評価器からは来ない。
    // **読みにも数えない。** 内容を置けない番地なので、変更されることがない。
    if (!isResolvable(address)) return NIL;

    this.#noteRead(address);

    const key = printAddress(address);
    const known = this.#values.get(key);
    if (known !== undefined) return known;

    const content = readContent(this.#sheet.contentAt(address));
    if (content.kind !== 'formula') {
      // **内容の解釈が返すのはリテラルの値なので、セルであることはない**（`HeldValue`）。
      // 型の上でそれを言えないだけなので、同じ解決を通して潰す。
      const value = content.kind === 'empty' ? NIL : heldValue(content.value);
      this.#values.set(key, value);
      // **定数セルも観測を伝える。** 読むものが無いだけで、索引から見れば同じセルである。
      this.#index.observe(address, { reads: [], dependencies: [] });
      return value;
    }

    // 木は内容が変わったときに作ってある。取れないのは呼び出しの最中にシートが
    // 変わった場合だけで、そのときは作り直す方が古い木を使うより正しい。
    const formula = this.#formulas.get(key) ?? this.#parseFormula(address, key, content.source);

    // **進行中のセルを読み直したなら、参照が巡っている**（§4.2、要件 F-4-3）。
    // **ここでは覚えない。** 値を入れるのは外側の枠で、そこが式全体の値を決める。
    if (this.#evaluating.has(key)) return CIRCULAR;

    this.#evaluating.add(key);
    this.#reads.push([]);
    try {
      const evaluation =
        formula.parsed.kind === 'failed'
          ? formula.parsed.evaluation
          : evaluateParsedFormula(formula.parsed.tree, this.values);
      // **セルはセルを保持しない**（`HeldValue`）。`=A1` のように数式がセルに評価されたら、
      // そのセルの値まで解決する（§4.2 の委譲と同じ）。**この解決も読みである**ので、
      // 記録の枠を畳む前に済ませる。
      const value = heldValue(evaluation.value);
      this.#values.set(key, value);
      return value;
    } finally {
      this.#evaluating.delete(key);
      this.#index.observe(address, {
        reads: this.#reads.pop() ?? [],
        dependencies: formula.dependencies,
      });
    }
  }

  /** 今評価しているセルが読んだ番地として覚える（要件 F-4-2）。 */
  #noteRead(address: CellAddress): void {
    this.#reads.at(-1)?.push(address);
  }
}

/**
 * シートを 1 度だけ再計算し、セルの値を答える関数を返す（フル再計算、要件 F-4-2）。
 *
 * **内容が変わった後の値は答えない。** 変更を伝えられる形は `LiveSheet` の方である。
 *
 * @param sheet セルの内容を持つシート
 * @param options 依存の抽出と無効化の索引の差し替え
 * @returns 番地からそのセルが保持する値を答える関数（§4.2）
 */
export function recalculate(sheet: Sheet, options: RecalculationOptions = {}): CellValues {
  return new Recalculation(sheet, options).values;
}

/**
 * 依存グラフをトポロジカル順序に並べる（要件 F-4-1、F-4-2）。
 *
 * **節点は数式セルだけである。** 定数セルと空セルの値は他のセルに依存しないので、
 * どこで読んでも同じ値になる。**増分再計算では汚れた数式セルだけを渡す**——
 * 汚れていないセルは既に値を持っており、辺を張る相手にならない。
 *
 * **循環に関わるセルは並びに現れない。** 入次数が 0 にならないためで、
 * 検出そのものは評価の側（進行中の印）が行う——静的な抽出は取りこぼしうるので、
 * **ここで「巡っている」と決めてしまうと取りこぼした巡りを見落とす。**
 *
 * @returns 依存する側が後に来る並び
 */
function topologicalOrder(formulas: ReadonlyMap<string, FormulaCell>): readonly FormulaCell[] {
  /** 依存されている側 → 依存する側。値が決まったときに入次数を減らす相手。 */
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of formulas.keys()) indegree.set(key, 0);

  for (const [key, cell] of formulas) {
    for (const precedent of precedentsOf(cell.dependencies, formulas)) {
      dependents.set(precedent, [...(dependents.get(precedent) ?? []), key]);
      indegree.set(key, (indegree.get(key) ?? 0) + 1);
    }
  }

  const queue = [...formulas.keys()].filter((key) => indegree.get(key) === 0);
  const order: FormulaCell[] = [];
  // **先頭から取り出すのに `shift` を使わない。** 並びが長いほど費用が嵩む。
  for (let index = 0; index < queue.length; index += 1) {
    const key = queue[index];
    if (key === undefined) continue;

    const cell = formulas.get(key);
    if (cell !== undefined) order.push(cell);

    for (const dependent of dependents.get(key) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) queue.push(dependent);
    }
  }

  return order;
}

/**
 * 依存のうち、数式セルにあたるものの綴り（要件 F-4-1）。
 *
 * **矩形は数式セルとの交わりだけを見る。** 矩形の中のセルを数え上げると、
 * `A1..A1000000` のような範囲で番地の数だけ費用がかかる。**シートは疎**なので、
 * 持っているセルの側から矩形に入るかを見る方が安い。
 */
function precedentsOf(
  dependencies: readonly Dependency[],
  formulas: ReadonlyMap<string, FormulaCell>,
): ReadonlySet<string> {
  const precedents = new Set<string>();

  for (const dependency of dependencies) {
    if (dependency.kind === 'cell') {
      const key = printAddress(dependency.address);
      if (formulas.has(key)) precedents.add(key);
      continue;
    }

    for (const [key, cell] of formulas) {
      if (isInside(dependency, cell.address)) precedents.add(key);
    }
  }

  return precedents;
}

/** 番地が矩形の中にあるか。**列は綴りの大小ではなく双射基数 26 の順**（`compareColumns`）。 */
function isInside(
  rectangle: { readonly topLeft: CellAddress; readonly bottomRight: CellAddress },
  address: CellAddress,
): boolean {
  return (
    compareColumns(rectangle.topLeft.column, address.column) <= 0 &&
    compareColumns(address.column, rectangle.bottomRight.column) <= 0 &&
    rectangle.topLeft.row <= address.row &&
    address.row <= rectangle.bottomRight.row
  );
}

/** 矩形の中のセルの数。 */
function areaOf(rectangle: {
  readonly topLeft: CellAddress;
  readonly bottomRight: CellAddress;
}): bigint {
  const columns = columnIndex(rectangle.bottomRight.column) - columnIndex(rectangle.topLeft.column);
  return (columns + 1n) * (rectangle.bottomRight.row - rectangle.topLeft.row + 1n);
}

/** 矩形の中のセルを数え上げる。**大きさは呼ぶ側が `areaOf` で確かめる。** */
function* cellsInside(rectangle: {
  readonly topLeft: CellAddress;
  readonly bottomRight: CellAddress;
}): Iterable<CellAddress> {
  const last = columnIndex(rectangle.bottomRight.column);
  for (let column = columnIndex(rectangle.topLeft.column); column <= last; column += 1n) {
    const spelling = columnAt(column);
    for (let row = rectangle.topLeft.row; row <= rectangle.bottomRight.row; row += 1n) {
      yield { column: spelling, row };
    }
  }
}
