import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './evaluate.ts';
import { printValue } from './value.ts';

/** 原文を評価し、§0.3 の表記にする。ゴールデンテストが見るのと同じ経路。 */
const evaluated = (source: string): string => printValue(evaluateFormula(source));

describe('evaluateFormula のリテラル', () => {
  it('整数を値にする', () => {
    expect(evaluateFormula('42')).toEqual({ kind: 'integer', value: 42n });
    expect(evaluated('0')).toBe('0');
    expect(evaluated('-5')).toBe('-5');
  });

  it('先頭の 0 は構文解析の段階で落ちている', () => {
    expect(evaluated('007')).toBe('7');
  });

  it('指数は仮数の種別を変えない（§2.1）', () => {
    expect(evaluateFormula('1e3')).toEqual({ kind: 'integer', value: 1000n });
    expect(evaluated('1.5e3')).toBe('1500.0');
    expect(evaluated('2e-3')).toBe('0.002');
  });

  it('小数を値にする', () => {
    expect(evaluateFormula('3.14')).toEqual({ kind: 'decimal', value: 3.14 });
  });

  it('文字列を値にする', () => {
    expect(evaluateFormula("'hello'")).toEqual({ kind: 'string', value: 'hello' });
    expect(evaluated("'It''s'")).toBe("'It''s'");
    expect(evaluated("''")).toBe("''");
  });

  it('シンボルを値にする', () => {
    expect(evaluateFormula('#foo')).toEqual({ kind: 'symbol', value: 'foo' });
    expect(evaluated('#at:put:')).toBe('#at:put:');
    expect(evaluated("#'hello world'")).toBe("#'hello world'");
  });

  it('真偽値と nil を値にする', () => {
    expect(evaluateFormula('true')).toEqual({ kind: 'boolean', value: true });
    expect(evaluated('false')).toBe('false');
    expect(evaluated('nil')).toBe('nil');
  });

  it('リテラル配列を値にする', () => {
    expect(evaluated('#(1 2 3)')).toBe('#(1 2 3)');
    expect(evaluated('#()')).toBe('#()');
    expect(evaluated("#(1 'two' #three true nil)")).toBe("#(1 'two' #three true nil)");
  });

  it('裸の識別子は配列の中ではシンボルになる（§2.4）', () => {
    expect(evaluated('#(foo bar)')).toBe('#(#foo #bar)');
  });

  it('入れ子のリテラル配列を値にする', () => {
    expect(evaluated('#(1 (2 3))')).toBe('#(1 #(2 3))');
  });
});

describe('evaluateFormula のエラー', () => {
  // 要件 F-8-1: エラーは値である。例外にすると評価の途中で制御が飛び、
  // §6.0 の伝播順序を値の受け渡しで表せなくなる。
  it('構文エラーを例外ではなく #Syntax の値にする', () => {
    expect(evaluateFormula('3 +')).toEqual({ kind: 'error', error: 'Syntax' });
    expect(evaluated('()')).toBe('#Syntax');
    expect(evaluated('(3 + 4')).toBe('#Syntax');
  });

  it('字句エラーも #Syntax の値にする', () => {
    // 閉じていない文字列・コメントは字句の段階で落ちる。
    expect(evaluated("'abc")).toBe('#Syntax');
    expect(evaluated('3 + 4 "閉じていない')).toBe('#Syntax');
  });

  it('数式が拒む構文も #Syntax（§7.3）', () => {
    expect(evaluated('a := 1')).toBe('#Syntax');
    expect(evaluated('^ 3')).toBe('#Syntax');
  });

  it('倍精度に収まらない小数のリテラルは #Overflow（ADR-0013）', () => {
    // 構文エラーではないので、構文解析器が木に載せたものをそのまま値にする。
    expect(evaluateFormula('1.0e400')).toEqual({ kind: 'error', error: 'Overflow' });
  });

  it('空の原文は #Syntax', () => {
    expect(evaluated('')).toBe('#Syntax');
  });
});

describe('evaluateFormula のまだ評価できないもの', () => {
  // 保留のケース（!pending）はここで例外になる。黙って別の値を返すと、
  // ゴールデンテストが「たまたま期待値と一致した」ことを検出できなくなる。
  it('メッセージ送信は例外にする', () => {
    expect(() => evaluateFormula('3 + 4')).toThrow(/未実装/);
    expect(() => evaluateFormula('-5 abs')).toThrow(/未実装/);
  });

  it('ブロックは例外にする', () => {
    expect(() => evaluateFormula('[1]')).toThrow(/未実装/);
  });

  it('セル参照は例外にする', () => {
    expect(() => evaluateFormula('A1')).toThrow(/未実装/);
  });

  it('裸の識別子は例外にする', () => {
    expect(() => evaluateFormula('foo')).toThrow(/未実装/);
  });
});

describe('evaluateFormula の実行上限', () => {
  /** `#(` を重ねた入力。入れ子の深さがそのまま再帰の深さになる。 */
  const nested = (depth: number): string => '#('.repeat(depth) + ')'.repeat(depth);

  // 深い入れ子は、構文解析器と評価器のどちらの再帰も尽きさせうる。どちらで尽きても
  // 仕様外の例外（RangeError）を漏らさず、#Timeout の値にする（§7.8）。
  // **どの深さで尽きるかはスタックの大きさ次第なので、境界そのものは固定しない。**
  it('再帰が尽きる深さでは #Timeout を値として返す', () => {
    expect(evaluateFormula(nested(100000))).toEqual({ kind: 'error', error: 'Timeout' });
  });

  it('例外を呼び出し元へ漏らさない', () => {
    expect(() => evaluateFormula(nested(100000))).not.toThrow();
  });

  it('上限に達しない深さはそのまま評価する', () => {
    expect(evaluated(nested(100))).toBe(nested(100));
  });
});
