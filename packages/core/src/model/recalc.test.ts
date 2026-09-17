import { describe, expect, it } from 'vitest';
import { printValue } from '../eval/value.ts';
import { parseAddress } from './address.ts';
import { recalculate } from './recalc.ts';
import { Sheet } from './sheet.ts';

/** 綴りを番地にする。テストの中で `null` を潰すためだけの補助。 */
function addressOf(spelling: string) {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} はセル参照の形ではありません。`);
  return address;
}

/** 内容を置いたシートを作る。 */
function sheetOf(contents: Record<string, string>): Sheet {
  const sheet = new Sheet();
  for (const [cell, content] of Object.entries(contents)) {
    sheet.put(addressOf(cell), content);
  }
  return sheet;
}

/** 内容を置いたシートを再計算し、あるセルの値を §0.3 の表記で取る。 */
function cellValue(contents: Record<string, string>, spelling: string): string {
  return printValue(recalculate(sheetOf(contents))(addressOf(spelling)));
}

describe('recalculate が答えるセルの値（§4.2、§4.4）', () => {
  it('内容の無いセルの値は nil（ADR-0010）', () => {
    expect(cellValue({}, 'A1')).toBe('nil');
    expect(cellValue({ A1: '1' }, 'B2')).toBe('nil');
  });

  it('リテラルちょうど 1 つの内容はその値（段 2）', () => {
    expect(cellValue({ A1: '1' }, 'A1')).toBe('1');
    expect(cellValue({ A1: "'abc'" }, 'A1')).toBe("'abc'");
    expect(cellValue({ A1: '#(1 2)' }, 'A1')).toBe('#(1 2)');
  });

  it('リテラルとして読めない内容は文字列（段 3）', () => {
    expect(cellValue({ A1: 'abc' }, 'A1')).toBe("'abc'");
    expect(cellValue({ A1: '1 + 2' }, 'A1')).toBe("'1 + 2'");
  });

  // ゴールデンテストのセルの指定（ADR-0009）は内容の前後を落とすため、
  // **空白の扱いはここでしか確かめられない。**
  it('内容の前後の空白は段 2 で無視される（§1.1）', () => {
    expect(cellValue({ A1: '  1  ' }, 'A1')).toBe('1');
  });

  it('空白だけの内容は文字列であって空セルではない（§4.4）', () => {
    expect(cellValue({ A1: '   ' }, 'A1')).toBe("'   '");
  });

  it('先頭に空白のある内容は数式にならない（§4.4 の段 1）', () => {
    expect(cellValue({ A1: '  =1 + 1' }, 'A1')).toBe("'  =1 + 1'");
  });

  it('番地は正規化されるので前ゼロは同じセルを指す（ADR-0020）', () => {
    expect(cellValue({ A007: '1' }, 'A7')).toBe('1');
    expect(cellValue({ A7: '1' }, 'A007')).toBe('1');
  });
});

describe('recalculate の数式セル（要件 F-4-1、F-4-2）', () => {
  it('数式セルの値は数式を評価した値', () => {
    expect(cellValue({ A1: '=1 + 1' }, 'A1')).toBe('2');
  });

  it('数式は他のセルを参照できる', () => {
    expect(cellValue({ A1: '1', B1: '=A1 + 1' }, 'B1')).toBe('2');
  });

  it('数式は他の数式セルを参照でき、順序どおりに解決される', () => {
    expect(cellValue({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10' }, 'C1')).toBe('20');
  });

  it('参照の向きは内容を置いた順に依らない', () => {
    expect(cellValue({ C1: '=B1 * 10', B1: '=A1 + 1', A1: '1' }, 'C1')).toBe('20');
  });

  it('数式が空セルを読めば nil（ADR-0010）', () => {
    expect(cellValue({ B1: '=A1 ifNil: [0]' }, 'B1')).toBe('0');
  });

  it('数式セルのエラーはそのセルの値になり、参照した側へ伝わる（要件 F-8-1）', () => {
    expect(cellValue({ A1: '=1 / 0' }, 'A1')).toBe('#DivideByZero');
    expect(cellValue({ A1: '=1 / 0', B1: '=A1 + 1' }, 'B1')).toBe('#DivideByZero');
  });

  it('数式が構文として読めなければ #Syntax（§0.3）', () => {
    expect(cellValue({ A1: '=B1 := 3' }, 'A1')).toBe('#Syntax');
    expect(cellValue({ A1: '=' }, 'A1')).toBe('#Syntax');
  });

  it('範囲を経由した依存も解決される', () => {
    expect(cellValue({ A1: '1', A2: '=A1 + 1', A3: '=A1..A2 sum' }, 'A3')).toBe('3');
  });

  // **トポロジカル順序で回す理由がこれである。** 参照された順に潜って評価すると、
  // 鎖の長さがそのまま再帰の深さになり、スタックが尽きて `#Timeout` になる（§7.8 の安全網）。
  it('長い参照の鎖も評価できる', () => {
    const contents: Record<string, string> = { A1: '1' };
    for (let row = 2; row <= 1000; row += 1) contents[`A${row}`] = `=A${row - 1} + 1`;
    expect(cellValue(contents, 'A1000')).toBe('1000');
  });
});

describe('recalculate の循環参照（要件 F-4-3）', () => {
  it('自分自身を参照する数式は #Circular', () => {
    expect(cellValue({ A1: '=A1' }, 'A1')).toBe('#Circular');
  });

  it('互いを参照する 2 つのセルはどちらも #Circular', () => {
    expect(cellValue({ A1: '=B1', B1: '=A1' }, 'A1')).toBe('#Circular');
    expect(cellValue({ A1: '=B1', B1: '=A1' }, 'B1')).toBe('#Circular');
  });

  it('3 つのセルが巡っていても検出される', () => {
    expect(cellValue({ A1: '=B1', B1: '=C1', C1: '=A1' }, 'B1')).toBe('#Circular');
  });

  it('循環に加わっていなくても、循環したセルを読めば #Circular が伝わる', () => {
    expect(cellValue({ A1: '=A1', B1: '=A1 + 1' }, 'B1')).toBe('#Circular');
  });

  it('自分を含む範囲を集計する数式も循環である', () => {
    expect(cellValue({ A1: '=A1..A3 sum' }, 'A1')).toBe('#Circular');
  });

  it('循環に関わらないセルは巻き込まれない', () => {
    expect(cellValue({ A1: '=B1', B1: '=A1', C1: '7' }, 'C1')).toBe('7');
  });

  // **静的な抽出が取りこぼした読みでも循環になる**（ADR-0023 の安全網）。
  // `to:` の端が式なので矩形は静的に読めず、B3 は A1 の依存に現れない。
  // それでも評価が B3 を読み、B3 が A1 に戻るため巡りは閉じている。
  it('静的な抽出に現れない読みでも循環が検出される', () => {
    const contents = {
      A1: '=((A2..A2 detect: [:c | true] ifNone: [nil]) to: C4) sum',
      A2: '1',
      B3: '=A1',
      C4: '2',
    };
    expect(cellValue(contents, 'A1')).toBe('#Circular');
  });

  // **正しさを持つのは安全網の側である**（ADR-0023）。抽出は順序を決めるだけなので、
  // 何も抽出しない実装に差し替えても値は変わらない。段階 7 で方式を差し替えるための縫い目。
  it('依存を 1 つも抽出しない実装に差し替えても値は変わらない', () => {
    const sheet = sheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10', D1: '=D1' });
    const values = recalculate(sheet, { dependencies: () => [] });
    expect(printValue(values(addressOf('C1')))).toBe('20');
    expect(printValue(values(addressOf('D1')))).toBe('#Circular');
  });
});
