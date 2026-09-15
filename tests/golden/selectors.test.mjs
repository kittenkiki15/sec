/**
 * `selectors.mjs` の単体テスト。
 *
 * 網羅の検査そのもの（`consistency.test.mjs`）は、仕様書とフィクスチャが揃っている限り
 * 緑のままなので、**抽出と収集が本当に効いているかはここでしか確かめられない。**
 * 表の読み違えや木の辿り漏れがあると、検査が素通りして穴を見逃す。
 */
import { describe, expect, it } from 'vitest';
import { parseFormula, parseMacroBody } from '../../packages/core/src/syntax/parser.ts';
import { parseSelectorTables, sentSelectors } from './selectors.mjs';

describe('parseSelectorTables', () => {
  it('第 1 セルがちょうど「セレクタ」の表から、第 1 列の綴りを拾う', () => {
    const markdown = [
      '#### 算術',
      '',
      '| セレクタ | 引数 |',
      '| --- | --- |',
      '| `abs` | — |',
    ].join('\n');

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['abs']);
  });

  it('1 つのセルに並んだ綴りをすべて拾う', () => {
    const markdown = ['| セレクタ | 引数 |', '| --- | --- |', '| `+` `-` `*` | 数 |'].join('\n');

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['+', '-', '*']);
  });

  it('セレクタを見出しに結びつける', () => {
    const markdown = [
      '### 6.1 Number',
      '#### 比較',
      '| セレクタ | 引数 |',
      '| --- | --- |',
      '| `<` | 数 |',
    ].join('\n');

    expect(parseSelectorTables(markdown).get('<')).toBe('比較');
  });

  it('第 1 セルが「セレクタ」で始まるだけの表は拾わない', () => {
    // §7.7 の `| セレクタ（do: を含む） |` と付録 A の `| セレクタの文脈依存 |` は
    // 綴りの一覧ではない。前方一致で拾うと表でないものが混ざる。
    const markdown = [
      '| セレクタ（`do:` を含む） | すべて送れる |',
      '| --- | --- |',
      '| カスケード `;` | 無い |',
      '',
      '| セレクタの文脈依存 | 持たせない |',
      '| --- | --- |',
      '| `^` | — |',
    ].join('\n');

    expect(parseSelectorTables(markdown).size).toBe(0);
  });

  it('エスケープした `\\|` はセル区切りではない', () => {
    // Boolean の `|` セレクタ。素朴に split('|') すると綴りが壊れる。
    const markdown = ['| セレクタ | 引数 |', '| --- | --- |', '| `&` `\\|` | 真偽値 |'].join('\n');

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['&', '|']);
  });

  it('第 2 列以降の綴りは拾わない', () => {
    const markdown = [
      '| セレクタ | 引数 | 返り値 |',
      '| --- | --- | --- |',
      '| `size` | — | `Integer` |',
    ].join('\n');

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['size']);
  });

  it('表が終われば読むのをやめる', () => {
    const markdown = [
      '| セレクタ | 引数 |',
      '| --- | --- |',
      '| `abs` | — |',
      '',
      '`negated` は本文に書いた綴りなので拾わない。',
    ].join('\n');

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['abs']);
  });

  it('表が 1 つも無ければ空を返す', () => {
    expect(parseSelectorTables('# 見出しだけ\n\n本文。').size).toBe(0);
  });

  it('綴りの無い行は飛ばす', () => {
    const markdown = ['| セレクタ | 引数 |', '| --- | --- |', '| — | — |', '| `abs` | — |'].join(
      '\n',
    );

    expect([...parseSelectorTables(markdown).keys()]).toEqual(['abs']);
  });
});

describe('sentSelectors', () => {
  const ofFormula = (source) => [...sentSelectors(parseFormula(source))].sort();

  it('単項・二項・キーワードを拾う', () => {
    expect(ofFormula('3 abs')).toEqual(['abs']);
    expect(ofFormula('1 + 2')).toEqual(['+']);
    expect(ofFormula('1 between: 0 and: 2')).toEqual(['between:and:']);
  });

  it('受け手と引数の中まで辿る', () => {
    expect(ofFormula('(1 abs) max: (2 negated)')).toEqual(['abs', 'max:', 'negated']);
  });

  it('ブロックの中まで辿る', () => {
    expect(ofFormula('#(1 2) collect: [:x | x squared]')).toEqual(['collect:', 'squared']);
  });

  it('範囲は to: の送信に脱糖されている', () => {
    // §4.3 のとおり範囲専用のノードは無い。表の `to:` はここで満たされる。
    expect(ofFormula('A1:B2')).toEqual(['to:']);
  });

  it('マクロの文の列・代入の右辺・返却の値まで辿る', () => {
    const body = parseMacroBody('| a |\na := 3 abs.\n^ a negated');

    expect([...sentSelectors(body)].sort()).toEqual(['abs', 'negated']);
  });

  it('送信の無い木では空を返す', () => {
    expect(ofFormula('42')).toEqual([]);
    expect(ofFormula("#(1 'a' #b true nil)")).toEqual([]);
  });

  it('同じセレクタを重ねて数えない', () => {
    expect(ofFormula('1 + 2 + 3')).toEqual(['+']);
  });
});
