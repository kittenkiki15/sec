/**
 * シート。**セルの内容を原文テキストで保持する**（要件 F-5-1）。
 *
 * **値は持たない。** 値は再計算の結果であり（要件 F-4）、数式セルの値を出すには
 * 他のセルの値が要る。`.secbook` の保存・読み込み（F-5-1）と数式バー（F-7）が
 * 原文を要求するので、**原文が本体で、値はそこから導かれる**という向きにしてある。
 *
 * **キーは正規化した番地**（[ADR-0020](../../../../docs/adr/0020-cell-address-normalization.md)）。
 * `A007` と `A7` は同じ 1 つのセルになる。
 */

import { type CellAddress, isResolvable, printAddress } from './address.ts';

export class Sheet {
  /** 正規化した番地の綴り → 内容の原文。**空のセルは持たない**（下記 `put`）。 */
  readonly #contents = new Map<string, string>();

  /**
   * セルの内容を読む。
   *
   * @returns 内容の原文。**空のセルは空文字列**（ADR-0010 の `nil` になるのは値の側）
   */
  contentAt(address: CellAddress): string {
    return this.#contents.get(printAddress(address)) ?? '';
  }

  /**
   * セルに内容を置く。
   *
   * **空の内容を置くことはセルを空にすることである**（ADR-0010）。持ち続けると
   * 「内容が空文字列のセル」と「空のセル」が表の上で別物になるが、
   * **その 2 つを区別する規則はどこにも無い**（値として空文字列を持たせたいなら `''` と書く）。
   *
   * @throws {Error} 解決できない番地（行が 0）を渡した場合
   */
  put(address: CellAddress, content: string): void {
    // **存在しない番地にセルを作らせない。** 作れてしまうと `A0` が値を持ち、
    // §4.2 の「`A0` は `#Ref`」が破れる。利用者の打ち間違いではなく呼び出し側の誤りなので、
    // 仕様上のエラー値ではなく例外にする。
    //
    // **`RangeError` にはしない。** 評価器は深い入れ子の安全網として `RangeError` を
    // 捕まえて `#Timeout` にしており（`evaluateFormula`）、マクロのセルへの代入（§7.4、M4）が
    // 評価の途中でここを呼ぶようになったとき、**呼び出し側の誤りが打ち切りに化ける。**
    if (!isResolvable(address)) {
      throw new Error(
        `セル ${printAddress(address)} は存在しません。行は 1 始まりです（要件 F-1-3）。`,
      );
    }

    const key = printAddress(address);
    if (content === '') {
      this.#contents.delete(key);
      return;
    }
    this.#contents.set(key, content);
  }
}
