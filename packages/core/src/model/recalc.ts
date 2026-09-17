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
 */

import { evaluateParsedFormula, type ParsedFormula, parseFormulaOrFail } from '../eval/evaluate.ts';
import { type CellValues, type HeldValue, heldValue } from '../eval/value.ts';
import { type CellAddress, compareColumns, isResolvable, printAddress } from './address.ts';
import { readContent } from './content.ts';
import { type Dependency, type DependencyExtractor, staticDependencies } from './dependencies.ts';
import type { Sheet } from './sheet.ts';

/** 空セルの値（[ADR-0010](../../../../docs/adr/0010-empty-cell-value.md)）。 */
const NIL: HeldValue = { kind: 'nil' };

/** 参照が巡っているセルの値（§4.2、要件 F-4-3）。 */
const CIRCULAR: HeldValue = { kind: 'error', error: 'Circular' };

/** 数式を持つセル。**木は 1 度だけ作る**（依存の抽出と評価の両方が同じ木を使う）。 */
interface FormulaCell {
  readonly address: CellAddress;
  readonly parsed: ParsedFormula;
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
}

/**
 * シートを再計算し、セルの値を答える関数を返す（要件 F-4-2 のフル再計算）。
 *
 * **数式セルはすべて評価される。** 変更セルの下流だけを計算し直す増分再計算は段階 6。
 *
 * @param sheet セルの内容を持つシート
 * @param options 依存の抽出の差し替え
 * @returns 番地からそのセルが保持する値を答える関数（§4.2）
 */
export function recalculate(sheet: Sheet, options: RecalculationOptions = {}): CellValues {
  const formulas = collectFormulas(sheet);

  /** 求まった値。**再計算 1 回のあいだ、同じセルの値は 1 つである**（決定性、要件 F-4-4）。 */
  const values = new Map<string, HeldValue>();
  /** 値を求めている最中のセル。**読み直したら参照が巡っている**（要件 F-4-3）。 */
  const evaluating = new Set<string>();

  const cellValue: CellValues = (address) => {
    // 解決できない番地に値は無い。§4.2 が先に `#Ref` を返すので、評価器からは来ない。
    if (!isResolvable(address)) return NIL;

    const key = printAddress(address);
    const known = values.get(key);
    if (known !== undefined) return known;

    const content = readContent(sheet.contentAt(address));
    if (content.kind !== 'formula') {
      // **内容の解釈が返すのはリテラルの値なので、セルであることはない**（`HeldValue`）。
      // 型の上でそれを言えないだけなので、同じ解決を通して潰す。
      const value = content.kind === 'empty' ? NIL : heldValue(content.value);
      values.set(key, value);
      return value;
    }

    // **進行中のセルを読み直したなら、参照が巡っている**（§4.2、要件 F-4-3）。
    // **ここでは覚えない。** 値を入れるのは外側の枠で、そこが式全体の値を決める。
    if (evaluating.has(key)) return CIRCULAR;

    // 数式セルは `collectFormulas` が解析済み。取れないのは呼び出しの最中に
    // シートが変わった場合だけで、そのときは解析し直す方が古い木を使うより正しい。
    const formula = formulas.get(key) ?? { address, parsed: parseFormulaOrFail(content.source) };

    evaluating.add(key);
    try {
      const evaluation =
        formula.parsed.kind === 'failed'
          ? formula.parsed.evaluation
          : evaluateParsedFormula(formula.parsed.tree, cellValue);
      // **セルはセルを保持しない**（`HeldValue`）。`=A1` のように数式がセルに評価されたら、
      // そのセルの値まで解決する（§4.2 の委譲と同じ）。
      const value = heldValue(evaluation.value);
      values.set(key, value);
      return value;
    } finally {
      evaluating.delete(key);
    }
  };

  // **トポロジカル順序で回す**（要件 F-4-2）。依存の側が先に値を持つので、
  // 鎖がどれだけ長くても評価の入れ子は 1 段で済む。
  const extract = options.dependencies ?? staticDependencies;
  for (const cell of topologicalOrder(formulas, extract)) cellValue(cell.address);

  // **順序に載らなかったセルもここで値を持つ。** 載らないのは循環に関わるセル
  // （と、静的な抽出がそう見たセル）で、値は安全網が決める。
  for (const cell of formulas.values()) cellValue(cell.address);

  return cellValue;
}

/** 数式を持つセルを集め、木にしておく。キーは正規化した番地の綴り（ADR-0020）。 */
function collectFormulas(sheet: Sheet): ReadonlyMap<string, FormulaCell> {
  const formulas = new Map<string, FormulaCell>();
  for (const address of sheet.addresses()) {
    const content = readContent(sheet.contentAt(address));
    if (content.kind !== 'formula') continue;
    formulas.set(printAddress(address), { address, parsed: parseFormulaOrFail(content.source) });
  }
  return formulas;
}

/**
 * 依存グラフをトポロジカル順序に並べる（要件 F-4-1、F-4-2）。
 *
 * **節点は数式セルだけである。** 定数セルと空セルの値は他のセルに依存しないので、
 * どこで読んでも同じ値になる。
 *
 * **循環に関わるセルは並びに現れない。** 入次数が 0 にならないためで、
 * 検出そのものは評価の側（進行中の印）が行う——静的な抽出は取りこぼしうるので、
 * **ここで「巡っている」と決めてしまうと取りこぼした巡りを見落とす。**
 *
 * @returns 依存する側が後に来る並び
 */
function topologicalOrder(
  formulas: ReadonlyMap<string, FormulaCell>,
  extract: DependencyExtractor,
): readonly FormulaCell[] {
  /** 依存されている側 → 依存する側。値が決まったときに入次数を減らす相手。 */
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const key of formulas.keys()) indegree.set(key, 0);

  for (const [key, cell] of formulas) {
    // 読めなかった数式は何にも依存しない。値は `#Syntax` で、他のセルを読まない。
    if (cell.parsed.kind !== 'parsed') continue;

    for (const precedent of precedentsOf(extract(cell.parsed.tree), formulas)) {
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
