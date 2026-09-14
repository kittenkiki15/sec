import { describe, expect, it } from 'vitest';
import { buildDiffSections, commentableLines, fetchChangedFiles } from './ai-review.mjs';

/** n バイトのダミー patch を作る。 */
const patchOf = (bytes) => '+'.repeat(bytes);

describe('commentableLines', () => {
  it('追加行と文脈行の行番号を新しい側で数える', () => {
    const patch = [
      '@@ -1,4 +1,6 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      '+const c = 30;',
      ' const d = 4;',
      ' const e = 5;',
    ].join('\n');

    expect([...commentableLines(patch)].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5]);
  });

  it('複数のハンクで行番号が飛ぶことを扱える', () => {
    const patch = ['@@ -1,1 +1,1 @@', ' x();', '@@ -20,2 +22,3 @@', ' y();', '+z();'].join('\n');
    expect([...commentableLines(patch)].sort((x, y) => x - y)).toEqual([1, 22, 23]);
  });

  it('削除行は新しい側の行数を進めない', () => {
    const patch = ['@@ -1,3 +1,1 @@', '-a();', '-b();', ' c();'].join('\n');
    expect([...commentableLines(patch)]).toEqual([1]);
  });

  it('patch が無ければ空集合を返す', () => {
    expect([...commentableLines(undefined)]).toEqual([]);
  });
});

describe('buildDiffSections', () => {
  const file = (filename, patch, extra = {}) => ({
    filename,
    patch,
    status: 'modified',
    additions: 1,
    deletions: 0,
    ...extra,
  });

  it('レビュー対象のファイルを差分として並べる', () => {
    const { sections, skipped } = buildDiffSections([
      file('packages/core/src/a.ts', '+const a = 1;'),
    ]);

    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain('packages/core/src/a.ts');
    expect(sections[0]).toContain('+const a = 1;');
    expect(skipped).toEqual([]);
  });

  it('ロックファイル・生成物・バイナリを除外する', () => {
    const { sections, skipped } = buildDiffSections([
      file('pnpm-lock.yaml', '+x'),
      file('packages/web/dist/app.js', '+x'),
      file('assets/icon.png', '+x'),
      file('packages/core/src/a.ts', '+x'),
    ]);

    expect(sections).toHaveLength(1);
    expect(skipped).toHaveLength(3);
  });

  it('GitHub が patch を返さなかったファイルを skipped に記録する', () => {
    const { sections, skipped } = buildDiffSections([file('big.bin', undefined)]);

    expect(sections).toEqual([]);
    expect(skipped[0]).toContain('big.bin');
  });

  it('ファイル単位の上限で差分を切り詰める', () => {
    const { sections } = buildDiffSections([file('a.ts', patchOf(100))], { maxFileBytes: 20 });

    expect(sections[0]).toContain('※一部省略');
    expect(sections[0]).toContain('省略');
  });

  it('差分の合計が上限を超えない', () => {
    const files = [file('a.ts', patchOf(60)), file('b.ts', patchOf(60)), file('c.ts', patchOf(60))];

    const { totalBytes } = buildDiffSections(files, { maxTotalBytes: 100, maxFileBytes: 60 });

    expect(totalBytes).toBeLessThanOrEqual(100);
  });

  it('上限に達したファイルを理由付きで skipped に記録する', () => {
    const files = [file('a.ts', patchOf(100)), file('b.ts', patchOf(100))];

    const { skipped } = buildDiffSections(files, { maxTotalBytes: 100, maxFileBytes: 100 });

    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain('b.ts');
  });
});

describe('fetchChangedFiles', () => {
  /** 常に満杯のページを返す取得関数。ページ上限に到達する状況を作る。 */
  const alwaysFullPage = () => Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts` }));

  it('最終ページまで取得する', async () => {
    const pages = [
      Array.from({ length: 100 }, (_, i) => ({ filename: `a${i}.ts` })),
      [{ filename: 'b.ts' }],
    ];

    const { files, truncated } = await fetchChangedFiles(
      'o/r',
      1,
      async (page) => pages[page - 1] ?? [],
    );

    expect(files).toHaveLength(101);
    expect(truncated).toBe(false);
  });

  it('ページ上限に達したら truncated を立てる', async () => {
    const { files, truncated } = await fetchChangedFiles('o/r', 1, async () => alwaysFullPage());

    expect(files).toHaveLength(1000);
    expect(truncated).toBe(true);
  });
});
