import { describe, expect, it } from 'vitest';
import { printValue } from '../eval/value.ts';
import { parseAddress } from './address.ts';
import { Sheet } from './sheet.ts';
import { sheetValues } from './values.ts';

/** 綴りを番地にする。テストの中で `null` を潰すためだけの補助。 */
function addressOf(spelling: string) {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} はセル参照の形ではありません。`);
  return address;
}

/** 内容を置いたシートを作り、あるセルの値を §0.3 の表記で取る。 */
function valueOf(contents: Record<string, string>, spelling: string): string {
  const sheet = new Sheet();
  for (const [cell, content] of Object.entries(contents)) {
    sheet.put(addressOf(cell), content);
  }
  return printValue(sheetValues(sheet)(addressOf(spelling)));
}

describe('sheetValues（§4.2、§4.4）', () => {
  it('内容の無いセルの値は nil（ADR-0010）', () => {
    expect(valueOf({}, 'A1')).toBe('nil');
    expect(valueOf({ A1: '1' }, 'B2')).toBe('nil');
  });

  it('リテラルちょうど 1 つの内容はその値（段 2）', () => {
    expect(valueOf({ A1: '1' }, 'A1')).toBe('1');
    expect(valueOf({ A1: "'abc'" }, 'A1')).toBe("'abc'");
    expect(valueOf({ A1: '#(1 2)' }, 'A1')).toBe('#(1 2)');
  });

  it('リテラルとして読めない内容は文字列（段 3）', () => {
    expect(valueOf({ A1: 'abc' }, 'A1')).toBe("'abc'");
    expect(valueOf({ A1: '1 + 2' }, 'A1')).toBe("'1 + 2'");
  });

  // ゴールデンテストのセルの指定（ADR-0009）は内容の前後を落とすため、
  // **空白の扱いはここでしか確かめられない。**
  it('内容の前後の空白は段 2 で無視される（§1.1）', () => {
    expect(valueOf({ A1: '  1  ' }, 'A1')).toBe('1');
  });

  it('空白だけの内容は文字列であって空セルではない（§4.4）', () => {
    expect(valueOf({ A1: '   ' }, 'A1')).toBe("'   '");
  });

  it('先頭に空白のある内容は数式にならない（§4.4 の段 1）', () => {
    expect(valueOf({ A1: '  =1 + 1' }, 'A1')).toBe("'  =1 + 1'");
  });

  it('番地は正規化されるので前ゼロは同じセルを指す（ADR-0020）', () => {
    expect(valueOf({ A007: '1' }, 'A7')).toBe('1');
    expect(valueOf({ A7: '1' }, 'A007')).toBe('1');
  });

  // 数式セルの値は他のセルの値に依存する（§4.2）ので、依存グラフが要る（M3 段階 5）。
  // **黙って別の値を返さない。** 返すと、保留のゴールデンテストが
  // 「たまたま期待値と一致した」ことを検出できなくなる。
  it('数式を持つセルはまだ値にできない', () => {
    const sheet = new Sheet();
    sheet.put(addressOf('A1'), '=1 + 1');
    expect(() => sheetValues(sheet)(addressOf('A1'))).toThrow(/未実装/);
  });
});
