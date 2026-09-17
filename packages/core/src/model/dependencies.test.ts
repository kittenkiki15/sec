import { describe, expect, it } from 'vitest';
import { parseFormula } from '../syntax/parser.ts';
import { printAddress } from './address.ts';
import { type Dependency, staticDependencies } from './dependencies.ts';

/** 依存を読みやすい綴りにする。セルは `A1`、矩形は `A1..B2`（§4.3 の表記）。 */
const spell = (dependency: Dependency): string =>
  dependency.kind === 'cell'
    ? printAddress(dependency.address)
    : `${printAddress(dependency.topLeft)}..${printAddress(dependency.bottomRight)}`;

/** 数式の原文から依存の綴りを取る。 */
const dependenciesOf = (source: string): string[] =>
  staticDependencies(parseFormula(source)).map(spell);

describe('staticDependencies（要件 F-4-1）', () => {
  it('セル参照を含まない数式は何にも依存しない', () => {
    expect(dependenciesOf('1 + 2')).toEqual([]);
    expect(dependenciesOf('#(1 2) inject: 0 into: [:a :b | a + b]')).toEqual([]);
  });

  it('セル参照はそのセルへの依存になる', () => {
    expect(dependenciesOf('A1 + 1')).toEqual(['A1']);
    expect(dependenciesOf('A1 + B2')).toEqual(['A1', 'B2']);
  });

  it('同じセルを何度読んでも依存は 1 つ', () => {
    expect(dependenciesOf('A1 + A1')).toEqual(['A1']);
  });

  it('番地は正規化される（ADR-0020）', () => {
    expect(dependenciesOf('A007 + 1')).toEqual(['A7']);
  });

  it('範囲は矩形への依存になる（§4.3）', () => {
    expect(dependenciesOf('A1..B2 sum')).toEqual(['A1..B2']);
    expect(dependenciesOf('A1:B2 sum')).toEqual(['A1..B2']);
  });

  it('正準形の to: も矩形として読む。範囲は to: への脱糖だから（ADR-0007）', () => {
    expect(dependenciesOf('A1 to: B2')).toEqual(['A1..B2']);
  });

  it('矩形の向きは正規化される（§4.3）', () => {
    expect(dependenciesOf('B2 to: A1')).toEqual(['A1..B2']);
  });

  it('ブロックの中のセル参照も拾う', () => {
    expect(dependenciesOf('[:x | A1] value: 1')).toEqual(['A1']);
    expect(dependenciesOf('true ifTrue: [A1] ifFalse: [B2]')).toEqual(['A1', 'B2']);
  });

  // セル参照そのものは要素になれない（§2.4 が構文エラーにする）ので、
  // **リテラル配列から依存が出ることはない。** 裸の綴りはシンボルである。
  it('リテラル配列は何にも依存しない（§2.4）', () => {
    expect(dependenciesOf('#(1 abc) size')).toEqual([]);
  });

  it('解決できない番地は依存にならない。値は #Ref で、読むセルが無い（§4.2）', () => {
    expect(dependenciesOf('A0 + 1')).toEqual([]);
  });

  it('端が解決できない範囲は、解決できる側のセルだけが残る', () => {
    expect(dependenciesOf('A0..B2 sum')).toEqual(['B2']);
  });

  // **静的な抽出が取りこぼす形**（ADR-0023）。端がセル参照でない `to:` は矩形として読めず、
  // 評価してみるまでどのセルを読むか決まらない。取りこぼしは再計算の側の安全網が拾う。
  it('端が式の to: は矩形にならず、両端の式が読むセルだけが残る', () => {
    expect(dependenciesOf('(A1..A2 detect: [:c | true] ifNone: [nil]) to: C4')).toEqual([
      'A1..A2',
      'C4',
    ]);
  });
});
