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

import { type CellAddress, compareColumns } from '../model/address.ts';
import type { RangeValue } from './value.ts';

/**
 * 2 つの番地が張る矩形を作る。
 *
 * **両端は解決できる番地でなければならない**（§4.2 が先に `#Ref` を返すので、
 * ここへ来る番地は既にそうなっている）。左上と右下は**元の番地の列と行を組み替えて**
 * 作るが、どちらの成分も解決できる番地から来るので、組み合わせても解決できる。
 *
 * @param one 一方の端の番地
 * @param other もう一方の端の番地
 * @returns 正規化した矩形。左上と右下の対
 */
export function makeRange(one: CellAddress, other: CellAddress): RangeValue {
  const ascending = compareColumns(one.column, other.column) <= 0;
  const left = ascending ? one.column : other.column;
  const right = ascending ? other.column : one.column;

  const top = one.row <= other.row ? one.row : other.row;
  const bottom = one.row <= other.row ? other.row : one.row;

  return {
    kind: 'range',
    topLeft: { column: left, row: top },
    bottomRight: { column: right, row: bottom },
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
