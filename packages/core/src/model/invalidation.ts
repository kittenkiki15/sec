/**
 * 無効化の索引（要件 F-4-2）。**変更されたセルから、計算し直すセルを決める段。**
 *
 * 方式は [ADR-0024](../../../../docs/adr/0024-incremental-invalidation.md)。
 * **既定は「評価中に実際に読んだ番地」を覚える**（`recordedReads`）。
 *
 * **順序を決める依存の抽出（`dependencies.ts`）とは役割が違う。** 抽出は木だけを見るので
 * 範囲の端が式のとき取りこぼすが、順序が悪くなるだけで値は安全網が正す（ADR-0023）。
 * **増分再計算では取りこぼしが「古い値が残る」形で表に出る**ので、無効化の側は
 * 取りこぼさない材料を使う。
 *
 * **索引は差し替えられる**（`LiveSheetOptions.invalidation`）。段階 7 の `sec bench` が
 * 性能要件（N-1）を測ったとき、静的な依存の逆向きを引く索引に替えられるよう、
 * **観測には読みと静的な依存の両方を渡す。**
 */

import { type CellAddress, printAddress } from './address.ts';
import type { Dependency } from './dependencies.ts';

/** セルを計算し直したときに分かったこと。**索引はこのうち要るものだけを使う。** */
export interface CellObservation {
  /** 評価中に実際に読んだ番地。**空セルを読んだことも含む**（後から内容が入るため）。 */
  readonly reads: readonly CellAddress[];
  /** 木から静的に抽出した依存（要件 F-4-1）。**別方式の索引が使う余地。** */
  readonly dependencies: readonly Dependency[];
}

/**
 * 変更されたセルから、計算し直すセルを引くもの（要件 F-4-2）。
 *
 * **下流は直接の読み手だけを答えればよい。** 再計算の側が閉包を取る。
 */
export interface InvalidationIndex {
  /** セルを計算し直したときの観測を覚える。**同じセルの前の記録は置き換わる。** */
  observe(cell: CellAddress, observation: CellObservation): void;
  /** セルの記録を捨てる。 */
  forget(cell: CellAddress): void;
  /** その番地を読んでいるセル（直接の下流）。 */
  readersOf(address: CellAddress): Iterable<CellAddress>;
}

/** 索引を作るもの。**1 つの `LiveSheet` に 1 つの索引**が対応する。 */
export type InvalidationIndexFactory = () => InvalidationIndex;

/**
 * 実際に読んだ番地を覚える索引（ADR-0024 の既定）。
 *
 * **短絡して読まなかったセルは依存に数えない。** 読まなかったセルはその数式の値を
 * 変えないので、値としては穴にならない——枝が切り替わるときは、条件にしたセルが
 * 先に汚れるため計算し直され、そこで新しい枝を読む。
 */
export const recordedReads: InvalidationIndexFactory = () => new RecordedReads();

class RecordedReads implements InvalidationIndex {
  /**
   * 読んだ側の綴り → 読んだ番地の綴り。
   *
   * **観測し直したときに古い辺を消すのに要る。** 逆向きだけを持つと、
   * もう読んでいない番地から読み手を外せない。
   */
  readonly #reads = new Map<string, readonly string[]>();

  /** 読まれた番地の綴り → 読んだ側。**番地も持つのは、綴りから読み直さずに返すため。** */
  readonly #readers = new Map<string, Map<string, CellAddress>>();

  observe(cell: CellAddress, observation: CellObservation): void {
    this.forget(cell);

    const key = printAddress(cell);
    // **綴りで重ねる。** 同じセルを 2 度読んでも辺は 1 本である。
    const reads = [...new Set(observation.reads.map(printAddress))];
    this.#reads.set(key, reads);

    for (const read of reads) {
      let readers = this.#readers.get(read);
      if (readers === undefined) {
        readers = new Map();
        this.#readers.set(read, readers);
      }
      readers.set(key, cell);
    }
  }

  forget(cell: CellAddress): void {
    const key = printAddress(cell);
    for (const read of this.#reads.get(key) ?? []) {
      const readers = this.#readers.get(read);
      if (readers === undefined) continue;
      readers.delete(key);
      // **読み手のいなくなった番地は落とす。** 残すと、一度読まれただけの番地が
      // シートの寿命だけ索引に溜まる。
      if (readers.size === 0) this.#readers.delete(read);
    }
    this.#reads.delete(key);
  }

  readersOf(address: CellAddress): Iterable<CellAddress> {
    return this.#readers.get(printAddress(address))?.values() ?? [];
  }
}
