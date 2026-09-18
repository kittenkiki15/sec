/**
 * 値を保つシート（要件 F-4-2）。**書き込みと再計算を対にする入口。**
 *
 * `Sheet` は原文しか持たず（`sheet.ts`）、値は再計算の結果である（`recalc.ts`）。
 * **その 2 つを別々に持つと、書き込んだのに再計算を伝え忘れる形が書ける**——
 * 古い値は黙って残るので、誤りが値として表に出るまで気付けない。
 * **`Sheet` を内部に持ち、書き込みを `put` に限る**ことで、この対を外せなくしてある。
 *
 * ```ts
 * const live = new LiveSheet([[a1, '1'], [b1, '=A1 + 1']]);
 * live.put(a1, '10');        // → [A1, B1]。下流だけが計算し直される
 * live.values(b1);           // → 11
 * ```
 *
 * **ブックではない。** ブックはシートの集合であり（要件 F-1-1）、保存の単位でもある。
 * ここが持つのは 1 枚のシートと、その値である。
 */

import type { CellValues } from '../eval/value.ts';
import type { CellAddress } from './address.ts';
import { Recalculation, type RecalculationOptions } from './recalc.ts';
import { Sheet } from './sheet.ts';

/** 差し替えられる部分（[ADR-0023](../../../../docs/adr/0023-dependency-extraction.md)、[ADR-0024](../../../../docs/adr/0024-incremental-invalidation.md)）。 */
export type LiveSheetOptions = RecalculationOptions;

export class LiveSheet {
  readonly #sheet = new Sheet();
  readonly #recalculation: Recalculation;

  /**
   * @param contents 初めに置く内容。**まとめて置いてから 1 度だけ再計算する**
   *   （1 つずつ `put` すると、置くたびに下流を計算し直すことになる）
   * @param options 依存の抽出と無効化の索引の差し替え
   * @throws {Error} 解決できない番地（行が 0）を含む場合
   */
  constructor(
    contents: Iterable<readonly [CellAddress, string]> = [],
    options: LiveSheetOptions = {},
  ) {
    for (const [address, content] of contents) this.#sheet.put(address, content);
    this.#recalculation = new Recalculation(this.#sheet, options);
  }

  /** 番地からそのセルが保持する値を答える（§4.2）。**評価器にそのまま渡せる形。** */
  get values(): CellValues {
    return this.#recalculation.values;
  }

  /**
   * セルの内容を読む（要件 F-5-1、F-7）。
   *
   * @returns 内容の原文。**空のセルは空文字列**（ADR-0010 の `nil` になるのは値の側）
   */
  contentAt(address: CellAddress): string {
    return this.#sheet.contentAt(address);
  }

  /**
   * セルに内容を置き、**下流だけを計算し直す**（増分再計算、要件 F-4-2）。
   *
   * **空の内容を置くことはセルを空にすることである**（ADR-0010）。
   *
   * @returns 計算し直したセルの番地。**変更したセル自身を含む。**
   *   グリッドの描き直し（要件 F-7）が要る範囲でもある
   * @throws {Error} 解決できない番地（行が 0）を渡した場合
   */
  put(address: CellAddress, content: string): readonly CellAddress[] {
    this.#sheet.put(address, content);
    return this.#recalculation.update(address);
  }
}
