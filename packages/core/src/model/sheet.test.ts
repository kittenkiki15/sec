import { describe, expect, it } from 'vitest';
import type { CellAddress } from './address.ts';
import { parseAddress } from './address.ts';
import { Sheet } from './sheet.ts';

/** テストの中でだけ使う。綴りが番地の形であることは `address.test.ts` が見ている。 */
const at = (spelling: string): CellAddress => {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`テストの綴りが番地の形ではありません: ${spelling}`);
  return address;
};

describe('Sheet', () => {
  it('新しいシートはどのセルも空', () => {
    const sheet = new Sheet();
    expect(sheet.contentAt(at('A1'))).toBe('');
  });

  it('内容は原文のまま保つ（要件 F-5-1）', () => {
    const sheet = new Sheet();
    sheet.put(at('A1'), '=B1 + 1');
    sheet.put(at('B1'), '  007  ');
    expect(sheet.contentAt(at('A1'))).toBe('=B1 + 1');
    expect(sheet.contentAt(at('B1'))).toBe('  007  ');
  });

  it('後から置いた内容が前の内容を置き換える', () => {
    const sheet = new Sheet();
    sheet.put(at('A1'), '1');
    sheet.put(at('A1'), '2');
    expect(sheet.contentAt(at('A1'))).toBe('2');
  });

  it('前ゼロの違う綴りは同じ 1 つのセル（ADR-0020）', () => {
    const sheet = new Sheet();
    sheet.put(at('A007'), '1');
    expect(sheet.contentAt(at('A7'))).toBe('1');

    sheet.put(at('A7'), '2');
    expect(sheet.contentAt(at('A007'))).toBe('2');
  });

  it('列と行が同じでなければ別のセル', () => {
    const sheet = new Sheet();
    sheet.put(at('A1'), '1');
    expect(sheet.contentAt(at('B1'))).toBe('');
    expect(sheet.contentAt(at('A2'))).toBe('');
    expect(sheet.contentAt(at('AA1'))).toBe('');
  });

  it('空の内容を置くと空のセルに戻る（ADR-0010）', () => {
    const sheet = new Sheet();
    sheet.put(at('A1'), '1');
    sheet.put(at('A1'), '');
    expect(sheet.contentAt(at('A1'))).toBe('');
  });

  it('解決できない番地にはセルを置けない（ADR-0020）', () => {
    const sheet = new Sheet();
    expect(() => sheet.put(at('A0'), '1')).toThrow(/A0/);
  });

  it('解決できない番地は常に空。読むことはできる', () => {
    const sheet = new Sheet();
    expect(sheet.contentAt(at('A0'))).toBe('');
  });
});
