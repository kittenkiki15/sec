import { describe, expect, it } from 'vitest';
import {
  columnAt,
  columnIndex,
  compareColumns,
  isResolvable,
  parseAddress,
  printAddress,
} from './address.ts';

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

describe('compareColumns', () => {
  // 範囲の正規化（§4.3）が列の大小を要る。**辞書順ではない。**
  it('綴りが短い列が先。双射基数 26 には前ゼロにあたる綴りが無い（ADR-0020）', () => {
    expect(compareColumns('Z', 'AA')).toBe(-1);
    expect(compareColumns('AA', 'Z')).toBe(1);
    expect(compareColumns('ZZ', 'AAA')).toBe(-1);
  });

  it('綴りの長さが同じなら辞書順', () => {
    expect(compareColumns('A', 'B')).toBe(-1);
    expect(compareColumns('B', 'A')).toBe(1);
    expect(compareColumns('AB', 'AA')).toBe(1);
  });

  it('同じ綴りは 0', () => {
    expect(compareColumns('A', 'A')).toBe(0);
    expect(compareColumns('ZZ', 'ZZ')).toBe(0);
  });
});

describe('columnIndex と columnAt', () => {
  // 範囲の列挙（§6.3）が列を左から右へ進める。綴りのままでは足せない。
  it('列の綴りを 1 始まりの位置にする', () => {
    expect(columnIndex('A')).toBe(1n);
    expect(columnIndex('Z')).toBe(26n);
    expect(columnIndex('AA')).toBe(27n);
    expect(columnIndex('AB')).toBe(28n);
    expect(columnIndex('ZZ')).toBe(702n);
    expect(columnIndex('AAA')).toBe(703n);
  });

  it('位置から列の綴りに戻す', () => {
    expect(columnAt(1n)).toBe('A');
    expect(columnAt(26n)).toBe('Z');
    expect(columnAt(27n)).toBe('AA');
    expect(columnAt(28n)).toBe('AB');
    expect(columnAt(702n)).toBe('ZZ');
    expect(columnAt(703n)).toBe('AAA');
  });

  // 双射基数 26 は 0 にあたる桁を持たない。`Z` の次が `AA` になるのはそのため。
  it('綴りと位置は 1 対 1 に対応する', () => {
    for (let index = 1n; index <= 1000n; index += 1n) {
      expect(columnIndex(columnAt(index))).toBe(index);
    }
  });

  it('綴りの長さに上限は無い（§4.1 は列の文字数を制限していない）', () => {
    expect(columnIndex('AAAAAAAAAA')).toBe(5646683826135n);
    expect(columnAt(5646683826135n)).toBe('AAAAAAAAAA');
  });

  // 大小の判定（`compareColumns`）と位置の大小は同じでなければならない。
  // 食い違うと、正規化した矩形の左上が右下より右になる。
  it('位置の大小は compareColumns と一致する', () => {
    expect(columnIndex('Z') < columnIndex('AA')).toBe(true);
    expect(columnIndex('ZZ') < columnIndex('AAA')).toBe(true);
    expect(columnIndex('AA') < columnIndex('AB')).toBe(true);
  });
});
