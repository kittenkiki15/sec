/**
 * ゴールデンテストのフィクスチャと、仕様書・要件定義書の整合を検証する。
 *
 * 期待値の正しさは検証しない（評価器ができてから）。ここで防ぎたいのは
 * **仕様書に無いものをフィクスチャが要求している**状態である。PR #11 の
 * レビューでは、この形の食い違いが繰り返し見つかった。
 *
 * セレクタの網羅までは見ない。キーワードメッセージは `detect:ifNone:` のように
 * 連結して 1 つのセレクタになるため、構文解析器なしに正しく切り出せず、
 * 誤検出の方が害になる。評価器ができたら M1 で入れ替える。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

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
  /** README の割り当て表に現れるフィクスチャ名。 */
  const listedNames = () =>
    new Set(
      read('tests', 'golden', 'README.md')
        .match(/`([a-z]+\.txt)`/g)
        ?.map((t) => t.slice(1, -1)) ?? [],
    );

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
