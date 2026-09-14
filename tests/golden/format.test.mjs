/**
 * ゴールデンテストのフィクスチャが、ハーネスの形式どおりに書けているかを検証する。
 *
 * フィクスチャは評価器が無い段階では「ただのデータファイル」で、誰も読まない。
 * 形式の壊れたケース（期待値の無いブロック、式の無い `=>` 行）が混ざったまま
 * M1 まで気づかないのを防ぐため、解析できることだけを先に固定する。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseGoldenFile } from '../../packages/core/src/testing/index.ts';

const goldenDir = dirname(fileURLToPath(import.meta.url));

const fixtures = readdirSync(goldenDir)
  .filter((name) => name.endsWith('.txt'))
  .sort();

describe('tests/golden のフィクスチャ', () => {
  it('1 件以上ある', () => {
    // 0 件でも下の it.each が素通りしてしまうため、件数を独立に確かめる。
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('%s は解析でき、1 件以上のケースを含む', (name) => {
    const text = readFileSync(join(goldenDir, name), 'utf8');

    const cases = parseGoldenFile(text, `tests/golden/${name}`);

    expect(cases.length).toBeGreaterThan(0);
    for (const testCase of cases) {
      expect(testCase.source, `tests/golden/${name}:${testCase.line} の式が空です。`).not.toBe('');
    }
  });
});
