import { describe, expect, it } from 'vitest';
import { readContent } from './content.ts';

describe('readContent の段 1（数式）', () => {
  it('内容が = で始まれば、残りが数式の原文になる（要件 F-2-1）', () => {
    expect(readContent('=A1 + 1')).toEqual({ kind: 'formula', source: 'A1 + 1' });
    expect(readContent('=1 + 2')).toEqual({ kind: 'formula', source: '1 + 2' });
  });

  it('= だけの内容も数式。原文が空なので評価すると #Syntax になる', () => {
    expect(readContent('=')).toEqual({ kind: 'formula', source: '' });
  });

  it('先頭に空白がある = は数式にしない（利用者の選択）', () => {
    expect(readContent('  =A1 + 1')).toEqual({
      kind: 'value',
      value: { kind: 'string', value: '  =A1 + 1' },
    });
  });

  it('= が途中にあっても数式にしない', () => {
    expect(readContent('1 = 2')).toEqual({
      kind: 'value',
      value: { kind: 'string', value: '1 = 2' },
    });
  });
});

describe('readContent の段 2（リテラルちょうど 1 つ）', () => {
  it('整数', () => {
    expect(readContent('1')).toEqual({ kind: 'value', value: { kind: 'integer', value: 1n } });
    expect(readContent('-5')).toEqual({ kind: 'value', value: { kind: 'integer', value: -5n } });
  });

  it('リテラルの正規化は §2.1 に従う', () => {
    expect(readContent('007')).toEqual({ kind: 'value', value: { kind: 'integer', value: 7n } });
    expect(readContent('1e3')).toEqual({ kind: 'value', value: { kind: 'integer', value: 1000n } });
  });

  it('小数', () => {
    expect(readContent('3.14')).toEqual({ kind: 'value', value: { kind: 'decimal', value: 3.14 } });
  });

  it('文字列・真偽値・シンボル・nil・リテラル配列', () => {
    expect(readContent("'abc'")).toEqual({
      kind: 'value',
      value: { kind: 'string', value: 'abc' },
    });
    expect(readContent('true')).toEqual({
      kind: 'value',
      value: { kind: 'boolean', value: true },
    });
    expect(readContent('#foo')).toEqual({ kind: 'value', value: { kind: 'symbol', value: 'foo' } });
    expect(readContent('nil')).toEqual({ kind: 'value', value: { kind: 'nil' } });
    expect(readContent('#(1 2)')).toEqual({
      kind: 'value',
      value: {
        kind: 'array',
        elements: [
          { kind: 'integer', value: 1n },
          { kind: 'integer', value: 2n },
        ],
      },
    });
  });

  it('前後の空白は無視する（§1.1、ADR-0021）', () => {
    expect(readContent('  1  ')).toEqual({ kind: 'value', value: { kind: 'integer', value: 1n } });
    expect(readContent('\t1\n')).toEqual({ kind: 'value', value: { kind: 'integer', value: 1n } });
  });

  it('リテラルとして読めても値がエラーになることがある（ADR-0013、ADR-0021）', () => {
    expect(readContent('1.0e400')).toEqual({
      kind: 'value',
      value: { kind: 'error', error: 'Overflow' },
    });
  });
});

describe('readContent の段 3（文字列）', () => {
  it('リテラルとして読めない内容は、そのまま文字列になる', () => {
    expect(readContent('abc')).toEqual({ kind: 'value', value: { kind: 'string', value: 'abc' } });
  });

  it('リテラルが 1 つでない内容も文字列。途中まで読めた分は採らない（ADR-0021）', () => {
    expect(readContent('1 + 2')).toEqual({
      kind: 'value',
      value: { kind: 'string', value: '1 + 2' },
    });
    expect(readContent('1 2')).toEqual({ kind: 'value', value: { kind: 'string', value: '1 2' } });
    expect(readContent('1 abc')).toEqual({
      kind: 'value',
      value: { kind: 'string', value: '1 abc' },
    });
  });

  it('セル参照はリテラルではない（§2）。内容として打てば文字列', () => {
    expect(readContent('A1')).toEqual({ kind: 'value', value: { kind: 'string', value: 'A1' } });
  });

  it('文字列は原文をそのまま持つ。前後の空白も落とさない', () => {
    expect(readContent(' abc ')).toEqual({
      kind: 'value',
      value: { kind: 'string', value: ' abc ' },
    });
  });

  it('空白だけの内容は文字列（利用者の選択）。空セルは原文が空のときだけ', () => {
    expect(readContent('   ')).toEqual({ kind: 'value', value: { kind: 'string', value: '   ' } });
  });

  it('閉じていない引用符も文字列。字句エラーは内容の解釈には出てこない', () => {
    expect(readContent("'abc")).toEqual({
      kind: 'value',
      value: { kind: 'string', value: "'abc" },
    });
  });
});

describe('readContent の空セル', () => {
  it('内容が空のセルは空。値は nil（ADR-0010、ADR-0021）', () => {
    expect(readContent('')).toEqual({ kind: 'empty' });
  });

  it("空文字列を値として持つセルとは別物（'' と書いて作る）", () => {
    expect(readContent("''")).toEqual({ kind: 'value', value: { kind: 'string', value: '' } });
  });
});
