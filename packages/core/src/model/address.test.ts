import { describe, expect, it } from 'vitest';
import { isResolvable, parseAddress, printAddress } from './address.ts';

describe('parseAddress', () => {
  it('列の綴りと行の数値に分ける', () => {
    expect(parseAddress('A1')).toEqual({ column: 'A', row: 1n });
    expect(parseAddress('B14')).toEqual({ column: 'B', row: 14n });
  });

  it('列は複数文字でもよい（§4.1）', () => {
    expect(parseAddress('AB12')).toEqual({ column: 'AB', row: 12n });
    expect(parseAddress('ZZZ1')).toEqual({ column: 'ZZZ', row: 1n });
  });

  it('行は十進数として読む。前ゼロは同じセルを指す（ADR-0020）', () => {
    expect(parseAddress('A007')).toEqual({ column: 'A', row: 7n });
    expect(parseAddress('A0007')).toEqual({ column: 'A', row: 7n });
    expect(parseAddress('A007')).toEqual(parseAddress('A7'));
  });

  it('行の桁数に上限が無い（§4.1、ADR-0020）', () => {
    expect(parseAddress('A99999999999999999999')).toEqual({
      column: 'A',
      row: 99999999999999999999n,
    });
  });

  it('行 0 も番地として読む。解決できないことは別の規則（ADR-0020）', () => {
    expect(parseAddress('A0')).toEqual({ column: 'A', row: 0n });
    expect(parseAddress('A000')).toEqual({ column: 'A', row: 0n });
  });

  it('セル参照の形でない綴りは番地にならない', () => {
    expect(parseAddress('')).toBeNull();
    expect(parseAddress('A')).toBeNull();
    expect(parseAddress('1')).toBeNull();
    expect(parseAddress('a1')).toBeNull();
    expect(parseAddress('A1B')).toBeNull();
    expect(parseAddress('A 1')).toBeNull();
    expect(parseAddress(' A1')).toBeNull();
    expect(parseAddress('$A$1')).toBeNull();
    expect(parseAddress('A1:B2')).toBeNull();
    expect(parseAddress('A1.5')).toBeNull();
  });
});

describe('printAddress', () => {
  it('列の綴りに行の十進表記を続ける', () => {
    expect(printAddress({ column: 'A', row: 1n })).toBe('A1');
    expect(printAddress({ column: 'AB', row: 12n })).toBe('AB12');
  });

  it('前ゼロは残らない（ADR-0020。範囲の表記もこの綴りになる）', () => {
    const address = parseAddress('A007');
    expect(address).not.toBeNull();
    if (address === null) return;
    expect(printAddress(address)).toBe('A7');
  });

  it('解決できない番地も書ける', () => {
    expect(printAddress({ column: 'A', row: 0n })).toBe('A0');
  });
});

describe('isResolvable', () => {
  it('行は 1 始まり（要件 F-1-3、§4.2）', () => {
    expect(isResolvable({ column: 'A', row: 1n })).toBe(true);
    expect(isResolvable({ column: 'A', row: 99999999999999999999n })).toBe(true);
  });

  it('正規化した結果が 0 の番地は解決できない（ADR-0020）', () => {
    expect(isResolvable({ column: 'A', row: 0n })).toBe(false);
  });

  // 番地は構造型なので、`parseAddress` を通さない値を呼び出し側が組み立てられる。
  it('列の綴りでない番地は解決できない', () => {
    expect(isResolvable({ column: 'A1', row: 2n })).toBe(false);
    expect(isResolvable({ column: '', row: 1n })).toBe(false);
    expect(isResolvable({ column: 'a', row: 1n })).toBe(false);
    expect(isResolvable({ column: 'A ', row: 1n })).toBe(false);
  });
});
