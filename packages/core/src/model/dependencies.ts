/**
 * 数式が読むセルの抽出（要件 F-4-1）。**依存グラフの辺を作る段。**
 *
 * **値を読まずに木だけを見る**（[ADR-0023](../../../../docs/adr/0023-dependency-extraction.md)）。
 * 依存は「どのセルを読みうるか」であって「何が入っているか」ではないので、
 * 抽出に値が要るなら順序を決める前に値が要ることになり、順序を決める意味が無くなる。
 *
 * **範囲は矩形として 1 つの依存にする。** `A1..A3 sum` は 3 つのセルを読むが、
 * 矩形は座標の対でしかなく（§4.3）、**両端の綴りから中身の番地が決まる。**
 *
 * **取りこぼしうる。** 範囲の端が式であれば（`(A1..A2 detect: ...) to: C4`）、
 * どの矩形になるかは評価するまで決まらない。**取りこぼした読みを拾うのは再計算の側の
 * 安全網**（`recalc.ts`）で、ここが答えるのは「順序を決めるのに使える依存」である。
 */

import { normalizeRectangle } from '../eval/range.ts';
import type { Expression, Statement } from '../syntax/parser.ts';
import { type CellAddress, isResolvable, parseAddress, printAddress } from './address.ts';

/** 数式が読みうるセル。**矩形はその中の全セルを指す。** */
export type Dependency =
  | { readonly kind: 'cell'; readonly address: CellAddress }
  | {
      readonly kind: 'rectangle';
      readonly topLeft: CellAddress;
      readonly bottomRight: CellAddress;
    };

/**
 * 数式から依存を抽出するもの（要件 F-4-1）。
 *
 * **関数にしてあるのは、抽出の方式を差し替えられるようにするため**（ADR-0023）。
 * 段階 7 の `sec bench` が性能上の問題を見つけたとき、抽出の粗さ（矩形を丸ごと 1 つの
 * 依存にするか、使う分だけに絞るか）が効いてくる余地がある。
 */
export type DependencyExtractor = (formula: Expression) => readonly Dependency[];

/** 正準形の範囲（§4.3、ADR-0007 D-1）。糖衣 `A1..B2` もここへ脱糖されている。 */
const RANGE_SELECTOR = 'to:';

/**
 * 数式の木からセル参照と範囲を集める（要件 F-4-1）。
 *
 * @param formula 数式の木
 * @returns 依存。**同じセル・同じ矩形は 1 つにまとまる**（`A1 + A1` の依存は 1 つ）
 */
export const staticDependencies: DependencyExtractor = (formula) => {
  // 綴りで重ねる。**重複を残すと、依存グラフの側が同じ辺を何度も数えることになる。**
  const found = new Map<string, Dependency>();

  const addCell = (address: CellAddress): void => {
    found.set(printAddress(address), { kind: 'cell', address });
  };

  const addRectangle = (one: CellAddress, other: CellAddress): void => {
    const rectangle = normalizeRectangle(one, other);
    const key = `${printAddress(rectangle.topLeft)}..${printAddress(rectangle.bottomRight)}`;
    found.set(key, { kind: 'rectangle', ...rectangle });
  };

  /** セル参照の綴りを、解決できる番地として読む。**`A0` は読まない**（値は `#Ref`、§4.2）。 */
  const resolvableAddress = (node: Expression): CellAddress | null => {
    if (node.kind !== 'cell') return null;
    const address = parseAddress(node.name);
    return address !== null && isResolvable(address) ? address : null;
  };

  const walkStatement = (statement: Statement): void => {
    // 代入と返却は数式に現れない（§7.3）が、木の型は両方を許す。**左辺は読まない**
    // ——セルへの代入は書き込みであって依存ではない（マクロ、§7.4）。
    if (statement.kind === 'assign' || statement.kind === 'return') {
      walk(statement.value);
      return;
    }
    walk(statement);
  };

  function walk(node: Expression): void {
    switch (node.kind) {
      case 'cell': {
        const address = resolvableAddress(node);
        if (address !== null) addCell(address);
        return;
      }
      case 'send': {
        const [argument] = node.arguments;
        if (node.selector === RANGE_SELECTOR && node.arguments.length === 1 && argument) {
          const one = resolvableAddress(node.receiver);
          const other = resolvableAddress(argument);
          // **両端がセル参照のときだけ矩形として読める。** 片方でも式なら、
          // どの矩形になるかは評価するまで決まらない（ADR-0023 の取りこぼし）。
          if (one !== null && other !== null) {
            addRectangle(one, other);
            return;
          }
        }
        walk(node.receiver);
        for (const each of node.arguments) walk(each);
        return;
      }
      // **ブロックの中も読む。** 評価が遅れるだけで、読むセルは同じである（§5.1）。
      case 'block':
        for (const statement of node.statements) walkStatement(statement);
        return;
      // リテラル配列の要素はリテラルであってセル参照ではない（§2.4）。`#(A1)` はシンボル。
      case 'array':
      case 'integer':
      case 'decimal':
      case 'string':
      case 'symbol':
      case 'boolean':
      case 'nil':
      case 'error':
      // 裸の識別子は解決できない（§4.2）。ブロックの引数はセルを指しうるが、
      // **その値が来る先は木の中の別の場所**なので、そこで数えられている。
      case 'identifier':
        return;
    }
  }

  walk(formula);
  return [...found.values()];
};
