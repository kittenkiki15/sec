import { describe, expect, it } from 'vitest';
import type { CellAddress } from './address.ts';
import { parseAddress, printAddress } from './address.ts';
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

  // 番地は構造型なので、`parseAddress` を通さない値を呼び出し側が組み立てられる。
  // 列の綴りを検査しないと、`printAddress` の単純連結が別のセルのキーと衝突する。
  it('列の綴りでない番地は、別のセルのキーと衝突しない', () => {
    const sheet = new Sheet();
    const bogus: CellAddress = { column: 'A1', row: 2n };

    expect(() => sheet.put(bogus, '衝突')).toThrow(/"A1" は列の綴りではありません/);
    expect(sheet.contentAt(bogus)).toBe('');
    expect(sheet.contentAt(at('A12'))).toBe('');
  });

  it('解決できない番地は常に空。読むことはできる', () => {
    const sheet = new Sheet();
    expect(sheet.contentAt(at('A0'))).toBe('');
  });
});

describe('Sheet の番地の列挙（要件 F-4-1）', () => {
  it('新しいシートは番地を 1 つも持たない', () => {
    expect(new Sheet().addresses()).toEqual([]);
  });

  it('内容を置いたセルの番地を答える。綴りは正規化されている（ADR-0020）', () => {
    const sheet = new Sheet();
    sheet.put(at('A007'), '1');
    sheet.put(at('B2'), '=A7 + 1');
    expect(sheet.addresses().map(printAddress).sort()).toEqual(['A7', 'B2']);
  });

  it('空にしたセルの番地は残らない（ADR-0010）', () => {
    const sheet = new Sheet();
    sheet.put(at('A1'), '1');
    sheet.put(at('A1'), '');
    expect(sheet.addresses()).toEqual([]);
  });
});
