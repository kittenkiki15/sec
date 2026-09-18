/**
 * セルの値を**グリッドに出す字面**にする（要件 F-7-1、F-7-4）。
 *
 * **`printValue` とは役目が違う。** `printValue`（§0.3）はゴールデンテストの期待値に書く
 * 表記で、**値の種別が字面から分かること**が要る。グリッドはそうではない——
 * 100 個の升目が並ぶ場所で、空セルに `nil` と書き、文字列に引用符を付けると、
 * **表として読めなくなる。** 差はその 2 つだけで、残りは §0.3 に従う。
 *
 * **エラーの種別を字面と別に返す**（要件 F-8-2）。`#Ref` という字面から `Ref` を
 * 切り出し直すのは、**表記の形に印付けが依存する**ことになる。
 */

import type { ErrorKind, HeldValue } from '@sec/core/eval';
import { printValue } from '@sec/core/eval';

export interface CellDisplay {
  /** グリッドの升目に出す字面。 */
  readonly text: string;
  /** エラーならその種別、そうでなければ `null`。**印を付けるかはこれで決まる。** */
  readonly error: ErrorKind | null;
}

export function displayValue(value: HeldValue): CellDisplay {
  switch (value.kind) {
    // 空セルの値は `nil` である（ADR-0010）。**値の側は変えない**——
    // 変えるのは見せ方だけで、`=A1 + 1` が `#TypeError` になることに影響しない。
    case 'nil':
      return { text: '', error: null };
    // 引用符はゴールデンの表記であって画面の表記ではない。Excel と同じく中身だけを出す。
    // **外すのは値そのものが文字列のときだけ。** 配列の要素まで外すと `#(a b)` が
    // シンボルの配列と見分けられなくなる。
    case 'string':
      return { text: value.value, error: null };
    case 'error':
      return { text: printValue(value), error: value.error };
    default:
      return { text: printValue(value), error: null };
  }
}
