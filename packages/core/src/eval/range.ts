/**
 * 範囲（仕様書 §4.3）。**セルの対から矩形を作る。**
 *
 * **向きは作る時点で正規化する。** `B10 to: A1` も `A1 to: B10` と同じ矩形を指す
 * （ドラッグの向きで結果が変わらない方が表計算の利用者の期待に沿う）。
 * **正規化を値の側に閉じ込めると、読む側が向きを気にしなくてよい。**
 *
 * **行と列は別々に正規化する**（§4.3）。`B1 to: A2` は `A1 to: B2` であって、
 * どちらかの番地をそのまま端に使うのではない。
 */

import { type CellAddress, columnAt, columnIndex, compareColumns } from '../model/address.ts';
import type { CellValue, CellValues, RangeValue } from './value.ts';

/**
 * 2 つの番地が張る矩形を作る。
 *
 * **両端は解決できる番地でなければならない**（§4.2 が先に `#Ref` を返すので、
 * ここへ来る番地は既にそうなっている）。左上と右下は**元の番地の列と行を組み替えて**
 * 作るが、どちらの成分も解決できる番地から来るので、組み合わせても解決できる。
 *
 * @param one 一方の端の番地
 * @param other もう一方の端の番地
 * @param values セルの値を答えるもの（§4.2）。**列挙が渡す要素が要る**（§6.3）
 * @returns 正規化した矩形。左上と右下の対
 */
export function makeRange(one: CellAddress, other: CellAddress, values: CellValues): RangeValue {
  const ascending = compareColumns(one.column, other.column) <= 0;
  const left = ascending ? one.column : other.column;
  const right = ascending ? other.column : one.column;

  const top = one.row <= other.row ? one.row : other.row;
  const bottom = one.row <= other.row ? other.row : one.row;

  return {
    kind: 'range',
    topLeft: { column: left, row: top },
    bottomRight: { column: right, row: bottom },
    values,
  };
}

/** 同じ矩形か（§6.3）。**要素の値は見ない**——範囲は座標の対であって値の入れ物ではない。 */
export function isSameRectangle(left: RangeValue, right: RangeValue): boolean {
  return (
    left.topLeft.column === right.topLeft.column &&
    left.topLeft.row === right.topLeft.row &&
    left.bottomRight.column === right.bottomRight.column &&
    left.bottomRight.row === right.bottomRight.row
  );
}

/** 矩形の幅（列の数）。**綴りのままでは引けない**ので位置に直す（双射基数 26）。 */
const widthOf = (range: RangeValue): bigint =>
  columnIndex(range.bottomRight.column) - columnIndex(range.topLeft.column) + 1n;

/**
 * 矩形のセルの数（§6.3 の `size`）。
 *
 * **範囲が空になることはない**（§6.3）。両端は解決できる番地で、正規化の後は
 * 左上が右下より左かつ上なので、幅も高さも 1 以上になる。
 *
 * **要素を並べずに答える。** 行の桁数に上限が無い（§4.1）ので `A1..A1e20` のような
 * 矩形が書けるが、個数は座標の引き算で決まる。
 */
export const rangeSize = (range: RangeValue): bigint =>
  widthOf(range) * (range.bottomRight.row - range.topLeft.row + 1n);

/**
 * 矩形の `i` 番目のセル（§6.3）。**添字は 1 起点**（ADR-0014）。
 *
 * **列挙は行優先**（[ADR-0015](../../../../docs/adr/0015-range-enumeration.md)）。
 * 左から右へ進み、行が尽きたら次の行へ移る。**位置から計算する**ので、
 * `at:` は矩形を並べずに答えられる（区間の要素と同じ扱い）。
 *
 * @param range 正規化した矩形
 * @param index 1 起点の添字。**範囲内であることは呼び出し側が確かめる**
 * @returns その位置のセル。**値は読まない**（読むのは委譲か `value` の送信）
 */
export function rangeCellAt(range: RangeValue, index: bigint): CellValue {
  const offset = index - 1n;
  const width = widthOf(range);
  return {
    kind: 'cell',
    address: {
      column: columnAt(columnIndex(range.topLeft.column) + (offset % width)),
      row: range.topLeft.row + offset / width,
    },
    values: range.values,
  };
}
