import { describe, expect, it } from 'vitest';
import { displayValue } from './display.ts';

describe('displayValue', () => {
  it('整数はそのまま出す', () => {
    expect(displayValue({ kind: 'integer', value: 42n })).toEqual({ text: '42', error: null });
  });

  it('小数は §0.3 の表記で出す', () => {
    expect(displayValue({ kind: 'decimal', value: 1.5 })).toEqual({ text: '1.5', error: null });
  });

  it('文字列は引用符を外して中身だけを出す', () => {
    expect(displayValue({ kind: 'string', value: 'abc' })).toEqual({ text: 'abc', error: null });
  });

  it('空の文字列は空欄になる', () => {
    expect(displayValue({ kind: 'string', value: '' })).toEqual({ text: '', error: null });
  });

  it('nil は空欄になる（空セルが 100 個の nil で埋まらないため）', () => {
    expect(displayValue({ kind: 'nil' })).toEqual({ text: '', error: null });
  });

  it('真偽値は §0.3 の表記で出す', () => {
    expect(displayValue({ kind: 'boolean', value: true })).toEqual({ text: 'true', error: null });
  });

  it('配列は §0.3 の表記で出す', () => {
    expect(
      displayValue({
        kind: 'array',
        elements: [
          { kind: 'integer', value: 1n },
          { kind: 'string', value: 'a' },
        ],
      }),
    ).toEqual({ text: "#(1 'a')", error: null });
  });

  it('配列の中の文字列は引用符が付いたまま（外すのは値そのものが文字列のときだけ）', () => {
    expect(displayValue({ kind: 'array', elements: [{ kind: 'string', value: 'a' }] })).toEqual({
      text: "#('a')",
      error: null,
    });
  });

  it('エラーは綴りを出し、種別を添える', () => {
    expect(displayValue({ kind: 'error', error: 'Ref' })).toEqual({ text: '#Ref', error: 'Ref' });
  });

  it('循環参照も同じ形で出る', () => {
    expect(displayValue({ kind: 'error', error: 'Circular' })).toEqual({
      text: '#Circular',
      error: 'Circular',
    });
  });

  it('ブロックは §0.3 の表記で出す', () => {
    expect(
      displayValue({
        kind: 'block',
        parameters: [],
        body: { temporaries: [], statements: [] },
        environment: new Map(),
      }),
    ).toEqual({ text: 'aBlock', error: null });
  });
});
