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

import type { MacroTransaction } from '../eval/evaluate.ts';
import type { CellValues } from '../eval/value.ts';
import { type CellAddress, printAddress } from './address.ts';
import { Recalculation, type RecalculationOptions } from './recalc.ts';
import { Sheet } from './sheet.ts';

/**
 * 1 回のマクロ実行の書き込みをまとめる単位（要件 F-3-4、[ADR-0027](../../../../docs/adr/0027-macro-execution.md) の案 C）。
 *
 * **書き込みは下流の値を捨てるだけで、計算は読まれたときと閉じたときにする。**
 * 閉じるのは `commit` か `rollback` のどちらか 1 回だけで、閉じた後は書けない。
 */
export interface SheetTransaction extends MacroTransaction {
  /**
   * セルに内容を置き、下流の値を捨てる。**読めば書き込みを反映した値になる。**
   *
   * @throws {Error} 閉じた後に呼んだ場合、解決できない番地（行が 0）を渡した場合
   */
  put(address: CellAddress, content: string): void;

  /**
   * 書き込みを確定し、捨てたままのセルをまとめて計算する。
   *
   * **計算してから閉じる。** 計算が例外で抜けたら開いたままなので、`rollback` できる。
   *
   * @returns 計算し直したセルの番地。**書き込んだセルと、途中で読まれたセルも含む**
   * @throws {Error} 閉じた後に呼んだ場合
   */
  commit(): readonly CellAddress[];

  /**
   * 書き込んだセルに開始前の原文を書き戻す。**値も開始前と同じになる**（要件 F-4-4）。
   *
   * **原文を戻したら閉じる。** 後の計算が例外で抜けても閉じており、値は読まれたときに戻る。
   *
   * @throws {Error} 閉じた後に呼んだ場合
   */
  rollback(): void;
}

/** 差し替えられる部分（[ADR-0023](../../../../docs/adr/0023-dependency-extraction.md)、[ADR-0024](../../../../docs/adr/0024-incremental-invalidation.md)）。 */
export type LiveSheetOptions = RecalculationOptions;

export class LiveSheet {
  readonly #sheet = new Sheet();
  readonly #recalculation: Recalculation;

  /**
   * 開いているトランザクション。**1 度に 1 つ**で、開いている間は `put` で書けない。
   * 外から書けると、巻き戻しがその書き込みを知らずに消すか、知らずに残す。
   */
  #transaction: SheetTransaction | null = null;

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
    if (this.#transaction !== null) {
      throw new Error('トランザクションが開いている間は put で書き込めません。');
    }
    this.#sheet.put(address, content);
    this.#recalculation.invalidate(address);
    return this.#recalculation.settle();
  }

  /**
   * トランザクションを開く（要件 F-3-4）。マクロの 1 回の実行がこの単位で書き込む。
   *
   * @throws {Error} 別のトランザクションが開いている場合
   */
  begin(): SheetTransaction {
    if (this.#transaction !== null) {
      throw new Error('トランザクションは 1 度に 1 つしか開けません。');
    }

    /** 書き込んだセルの開始前の原文。**そのセルへの最初の書き込みだけ**を控える。 */
    const originals = new Map<string, readonly [CellAddress, string]>();

    const write = (address: CellAddress, content: string): void => {
      const before = this.#sheet.contentAt(address);
      this.#sheet.put(address, content);
      this.#recalculation.invalidate(address);
      const key = printAddress(address);
      if (!originals.has(key)) originals.set(key, [address, before]);
    };

    const ensureOpen = (): void => {
      if (this.#transaction !== transaction) {
        throw new Error('閉じたトランザクションは使えません。');
      }
    };

    const transaction: SheetTransaction = {
      values: this.values,
      put: (address, content) => {
        ensureOpen();
        write(address, content);
      },
      commit: () => {
        ensureOpen();
        // **計算してから閉じる。** 計算が例外で抜けたときに開いたままなら、まだ巻き戻せる。
        const settled = this.#recalculation.settle();
        this.#transaction = null;
        return settled;
      },
      rollback: () => {
        ensureOpen();
        // **控えたのは原文**なので、書き込み先にあった数式もそのまま戻る（ADR-0027）。
        for (const [address, content] of originals.values()) {
          this.#sheet.put(address, content);
          this.#recalculation.invalidate(address);
        }
        // **原文を戻したら閉じる。** 後の計算が例外で抜けても、捨てたセルは読まれたときに
        // 計算されるので値は開始前に戻る。開いたままにすると、シートに二度と書けなくなる。
        this.#transaction = null;
        this.#recalculation.settle();
      },
    };
    this.#transaction = transaction;
    return transaction;
  }
}
