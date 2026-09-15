/**
 * ゴールデンテストのフィクスチャと、仕様書・要件定義書の整合を検証する。
 *
 * 期待値の正しさは検証しない（評価器ができてから）。ここで防ぎたいのは
 * **仕様書に無いものをフィクスチャが要求している**状態である。PR #11 の
 * レビューでは、この形の食い違いが繰り返し見つかった。
 *
 * **セレクタの網羅もここで見る。** 構文解析器ができるまでは、キーワードメッセージが
 * `detect:ifNone:` のように連結して 1 つのセレクタになるため正しく切り出せず、
 * 誤検出の方が害になるとして見送っていた（#21）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  parseFormula,
  parseMacroBody,
  parseMacroDefinition,
} from '../../packages/core/src/syntax/parser.ts';
import { parseGoldenFile } from '../../packages/core/src/testing/index.ts';
import { parseSelectorTables, sentSelectors } from './selectors.mjs';

const goldenDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(goldenDir, '..', '..');

const read = (...parts) => readFileSync(join(repoRoot, ...parts), 'utf8');

const fixtureNames = readdirSync(goldenDir)
  .filter((name) => name.endsWith('.txt'))
  .sort();

describe('エラー種別', () => {
  /** 要件 F-8-2 の行から、定められた種別を拾う。 */
  const declaredKinds = () => {
    const row = read('docs', '01-requirements.md')
      .split('\n')
      .find((line) => line.startsWith('| F-8-2 |'));
    expect(row, '要件定義書に F-8-2 の行が見つかりません。').toBeDefined();
    return new Set(row.match(/`#[A-Za-z]+`/g)?.map((token) => token.slice(1, -1)) ?? []);
  };

  it('F-8-2 が 1 つ以上の種別を定めている', () => {
    // 抽出が壊れて空集合になると、下の検証が素通りしてしまう。
    expect(declaredKinds().size).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s の期待値に現れる種別はすべて F-8-2 にある', (name) => {
    const kinds = declaredKinds();
    const text = readFileSync(join(goldenDir, name), 'utf8');

    for (const [index, line] of text.split('\n').entries()) {
      const match = line.match(/^=> (#[A-Z][A-Za-z]*)$/);
      if (match === null) continue;
      const kind = match[1];
      expect(
        kinds.has(kind),
        `tests/golden/${name}:${index + 1} の ${kind} が要件 F-8-2 に定められていません。` +
          ` 種別を増やすなら要件定義書と ADR を先に更新してください。`,
      ).toBe(true);
    }
  });
});

describe('ファイルの割り当て', () => {
  /**
   * README の**割り当て表の中に**現れるフィクスチャ名。
   *
   * 文書全体から拾うと、表から漏れていても説明文にファイル名が出てくるだけで
   * 検査を通ってしまう。見出しから次の見出しまでを切り出して、その範囲だけを見る。
   */
  const listedNames = () => {
    const readme = read('tests', 'golden', 'README.md');
    const start = readme.indexOf('## ファイルの割り当て');
    expect(start, 'README に「## ファイルの割り当て」の見出しが見つかりません。').toBeGreaterThan(
      -1,
    );
    const rest = readme.slice(start + 1);
    const end = rest.indexOf('\n## ');
    const section = end === -1 ? rest : rest.slice(0, end);
    return new Set(section.match(/`([a-z]+\.txt)`/g)?.map((name) => name.slice(1, -1)) ?? []);
  };

  it('README がフィクスチャを 1 つ以上挙げている', () => {
    expect(listedNames().size).toBeGreaterThan(0);
  });

  it.each(fixtureNames)('%s が README の割り当て表に載っている', (name) => {
    expect(
      listedNames().has(name),
      `tests/golden/${name} が README の割り当て表にありません。表を更新してください。`,
    ).toBe(true);
  });
});

describe('セレクタの網羅', () => {
  /**
   * ケースを開始記号どおりに解析して、セレクタを探す木を返す（ADR-0018、仕様書 §7.1）。
   *
   * シートに置いた数式も木にする。セルの内容は原文テキストで、`=` で始まれば数式である
   * （要件 F-5-1）。**マクロを起動するメッセージ（`!macro from: 1 to: 3`）は木にしない。**
   * 受け手を持たないため単独では解析できず、そこに現れるのはそのケースが定義した
   * セレクタなので、組み込みセレクタの網羅には寄与しない。
   */
  const treesOf = (testCase) => {
    const trees = [];
    if (testCase.kind === 'formula') trees.push(parseFormula(testCase.source));
    else if (testCase.send === null) trees.push(parseMacroBody(testCase.source));
    else trees.push(parseMacroDefinition(testCase.source).body);

    for (const content of testCase.sheet.values()) {
      if (content.startsWith('=')) trees.push(parseFormula(content.slice(1)));
    }
    return trees;
  };

  /**
   * フィクスチャ全体を解析して、送られているセレクタと、解析できなかったケースを返す。
   *
   * **解析できないケースを黙って飛ばさない。** `#Syntax` を期待するケースが落ちるのは
   * 正しい振る舞いだが、それ以外が落ちるのは木を組めていないということで、
   * そのケースのセレクタが数えられていない。網羅の穴と見分けが付かなくなる。
   */
  let analyzed = null;
  const analyze = () => {
    // 検査はセレクタごとに 1 件ずつ立てるので、毎回解析し直すとフィクスチャの数だけ効く。
    if (analyzed !== null) return analyzed;

    const used = new Map();
    const unexpected = [];

    for (const name of fixtureNames) {
      const text = readFileSync(join(goldenDir, name), 'utf8');
      for (const testCase of parseGoldenFile(text, `tests/golden/${name}`)) {
        const where = `tests/golden/${name}:${testCase.line}`;
        try {
          for (const tree of treesOf(testCase)) {
            for (const selector of sentSelectors(tree)) {
              used.set(selector, [...(used.get(selector) ?? []), where]);
            }
          }
        } catch (error) {
          if (testCase.expected === '#Syntax') continue;
          unexpected.push(`${where}（期待値 ${testCase.expected}）: ${error.message}`);
        }
      }
    }
    analyzed = { used, unexpected };
    return analyzed;
  };

  it('仕様書がセレクタ表を持っている', () => {
    // 表の読み方が変わって空集合になると、下の検証が 0 件になって素通りする。
    expect(declared.size).toBeGreaterThan(0);
  });

  it('解析できないケースは #Syntax を期待している', () => {
    expect(analyze().unexpected).toEqual([]);
  });

  const declared = parseSelectorTables(read('docs', '02-language-spec.md'));

  it.each([...declared])('%s を送るケースがフィクスチャにある', (selector, heading) => {
    expect(
      analyze().used.has(selector),
      `仕様書「${heading}」の ${selector} を送るケースが tests/golden にありません。` +
        ` セレクタを追加・変更したら対応するゴールデンテストも足してください（CLAUDE.md）。`,
    ).toBe(true);
  });
});
