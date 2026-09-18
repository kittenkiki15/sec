import { describe, expect, it } from 'vitest';
import { type CellAddress, parseAddress, printAddress } from './address.ts';
import { recordedReads } from './invalidation.ts';

/** 綴りを番地にする。テストの中で `null` を潰すためだけの補助。 */
function addressOf(spelling: string): CellAddress {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} はセル参照の形ではありません。`);
  return address;
}

/** 読んだ番地を綴りで渡す。静的な依存は既定の索引が使わないので空でよい。 */
function observe(index: ReturnType<typeof recordedReads>, cell: string, reads: string[]): void {
  index.observe(addressOf(cell), { reads: reads.map(addressOf), dependencies: [] });
}

/** その番地を読んでいるセルの綴り。並びには意味を持たせない。 */
function readersOf(index: ReturnType<typeof recordedReads>, address: string): readonly string[] {
  return [...index.readersOf(addressOf(address))].map(printAddress).sort();
}

describe('recordedReads（ADR-0024）', () => {
  it('読んだセルから、読んだ側を引ける', () => {
    const index = recordedReads();
    observe(index, 'B1', ['A1']);
    observe(index, 'C1', ['A1', 'B1']);

    expect(readersOf(index, 'A1')).toEqual(['B1', 'C1']);
    expect(readersOf(index, 'B1')).toEqual(['C1']);
  });

  it('読まれていない番地の読み手はいない', () => {
    const index = recordedReads();
    observe(index, 'B1', ['A1']);

    expect(readersOf(index, 'Z9')).toEqual([]);
  });

  // **計算し直したセルの記録は置き換わる。** 古い読みが残ると、もう読んでいないセルの
  // 変更で計算し直すことになり、増分である意味が薄れる。
  it('同じセルを観測し直すと、前の読みは残らない', () => {
    const index = recordedReads();
    observe(index, 'B1', ['A1']);
    observe(index, 'B1', ['A2']);

    expect(readersOf(index, 'A1')).toEqual([]);
    expect(readersOf(index, 'A2')).toEqual(['B1']);
  });

  it('忘れたセルは読み手に現れない', () => {
    const index = recordedReads();
    observe(index, 'B1', ['A1']);
    index.forget(addressOf('B1'));

    expect(readersOf(index, 'A1')).toEqual([]);
  });

  it('番地は正規化して扱う（ADR-0020）', () => {
    const index = recordedReads();
    observe(index, 'B007', ['A007']);

    expect(readersOf(index, 'A7')).toEqual(['B7']);
  });
});
