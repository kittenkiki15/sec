import { describe, expect, it } from 'vitest';
import {
  formatGoldenFailures,
  type GoldenCase,
  GoldenParseError,
  parseGoldenFile,
  runGoldenCases,
} from './golden.ts';

describe('parseGoldenFile', () => {
  it('1 行の式と期待値を読み取る', () => {
    const cases = parseGoldenFile('3 + 4 * 2\n=> 14\n');
    expect(cases).toEqual([{ source: '3 + 4 * 2', expected: '14', line: 1 }]);
  });

  it('空行で区切られた複数のケースを読み取る', () => {
    const text = ['3 + 4\n=> 7', '', '10 sqrt\n=> 3.1622776601683795', ''].join('\n');
    const cases = parseGoldenFile(text);

    expect(cases.map((c) => c.source)).toEqual(['3 + 4', '10 sqrt']);
    expect(cases.map((c) => c.expected)).toEqual(['7', '3.1622776601683795']);
  });

  it('式の開始行を記録する', () => {
    const text = ['"見出し"', '', '3 + 4', '=> 7', '', '1 / 0', '=> #DivideByZero'].join('\n');
    expect(parseGoldenFile(text).map((c) => c.line)).toEqual([3, 6]);
  });

  it('行頭が二重引用符の行をコメントとして読み飛ばす', () => {
    const text = ['"算術の優先順位', '3 + 4 * 2', '"ここもコメント', '=> 14'].join('\n');
    expect(parseGoldenFile(text)).toEqual([{ source: '3 + 4 * 2', expected: '14', line: 2 }]);
  });

  it('複数行の式をそのまま保持する', () => {
    const text = ['| a |', 'a := 3.', '^ a + 1', '=> 4'].join('\n');
    expect(parseGoldenFile(text)[0]?.source).toBe('| a |\na := 3.\n^ a + 1');
  });

  it('複数行の期待値を連結する', () => {
    const text = ['#(1 2)', '=> #(1', '     2)'].join('\n');
    expect(parseGoldenFile(text)[0]?.expected).toBe('#(1\n     2)');
  });

  it('行末の空白を無視する', () => {
    expect(parseGoldenFile('3 + 4   \n=> 7   \n')[0]).toEqual({
      source: '3 + 4',
      expected: '7',
      line: 1,
    });
  });

  it('CRLF 改行を扱える', () => {
    expect(parseGoldenFile('3 + 4\r\n=> 7\r\n')[0]?.expected).toBe('7');
  });

  it('空のファイルからはケースを作らない', () => {
    expect(parseGoldenFile('')).toEqual([]);
    expect(parseGoldenFile('\n\n  \n')).toEqual([]);
    expect(parseGoldenFile('"コメントだけ\n')).toEqual([]);
  });

  it('期待値の無いケースを拒否する', () => {
    expect(() => parseGoldenFile('3 + 4\n', 'a.txt')).toThrow(GoldenParseError);
    expect(() => parseGoldenFile('3 + 4\n', 'a.txt')).toThrow(/a\.txt:1: 期待値がありません/);
  });

  it('式の無いケースを拒否する', () => {
    expect(() => parseGoldenFile('=> 14\n', 'a.txt')).toThrow(
      /a\.txt:1: "=>" の前に式がありません/,
    );
  });

  it('期待値が空のケースを拒否する', () => {
    expect(() => parseGoldenFile('3 + 4\n=>\n', 'a.txt')).toThrow(/a\.txt:2: 期待値が空です/);
  });

  it('例外に行番号を持たせる', () => {
    try {
      parseGoldenFile('3 + 4\n=> 7\n\n10 sqrt\n', 'a.txt');
      expect.unreachable('GoldenParseError が送出されるはず');
    } catch (error) {
      expect(error).toBeInstanceOf(GoldenParseError);
      expect((error as GoldenParseError).line).toBe(4);
    }
  });
});

describe('runGoldenCases', () => {
  const cases: GoldenCase[] = [
    { source: '3 + 4', expected: '7', line: 1 },
    { source: '10 sqrt', expected: '3.16', line: 4 },
  ];

  it('全て一致すれば失敗を返さない', () => {
    const failures = runGoldenCases(cases, (source) => (source === '3 + 4' ? '7' : '3.16'));
    expect(failures).toEqual([]);
  });

  it('一致しないケースを実際の値付きで返す', () => {
    const failures = runGoldenCases(cases, () => '7');

    expect(failures).toHaveLength(1);
    expect(failures[0]?.testCase.source).toBe('10 sqrt');
    expect(failures[0]?.actual).toBe('7');
    expect(failures[0]?.thrown).toBeNull();
  });

  it('例外を捕捉して残りのケースを続行する', () => {
    const evaluated: string[] = [];
    const failures = runGoldenCases(cases, (source) => {
      evaluated.push(source);
      if (source === '3 + 4') throw new Error('未実装');
      return '3.16';
    });

    expect(evaluated).toEqual(['3 + 4', '10 sqrt']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.actual).toBeNull();
    expect(failures[0]?.thrown).toBe('未実装');
  });

  it('Error 以外が投げられても文字列化する', () => {
    const failures = runGoldenCases([cases[0] as GoldenCase], () => {
      throw 'ただの文字列';
    });
    expect(failures[0]?.thrown).toBe('ただの文字列');
  });
});

describe('formatGoldenFailures', () => {
  it('ファイルと行を辿れる形にまとめる', () => {
    const failures = runGoldenCases([{ source: '3 + 4', expected: '7', line: 12 }], () => '8');
    const message = formatGoldenFailures(failures, 'arithmetic.txt');

    expect(message).toContain('arithmetic.txt: 1 件のゴールデンテストが失敗しました。');
    expect(message).toContain('arithmetic.txt:12');
    expect(message).toContain('期待値: 7');
    expect(message).toContain('実際  : 8');
  });

  it('例外で終わったケースは例外として表示する', () => {
    const failures = runGoldenCases([{ source: 'x', expected: '1', line: 3 }], () => {
      throw new Error('未実装');
    });
    expect(formatGoldenFailures(failures, 'a.txt')).toContain('例外  : 未実装');
  });

  it('複数行の式を字下げして表示する', () => {
    const failures = runGoldenCases(
      [{ source: '| a |\n^ a', expected: 'nil', line: 1 }],
      () => 'x',
    );
    expect(formatGoldenFailures(failures, 'a.txt')).toContain('式    : | a |\n          ^ a');
  });
});
