/**
 * ゴールデンテストを実際に評価して、期待値と突き合わせる。
 *
 * **対象のファイルは段階ごとに増やす**（`docs/NEXT.md` の M2 の段階割り）。
 * 全ファイルを一度に対象にすると、まだ書いていない評価器の分がすべて赤になり、
 * **赤が既定の状態になって新しく壊れたことに気付けなくなる**（ADR-0019 の背景）。
 *
 * ファイルの中で実装待ちのケースには `!pending` の印が付いている。
 * 印の付いたケースは落ちても緑だが、**通ってしまえば赤になる。**
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluateFormula, printValue } from '../../packages/core/src/eval/index.ts';
import {
  formatGoldenFailures,
  parseGoldenFile,
  runGoldenCases,
} from '../../packages/core/src/testing/index.ts';

const goldenDir = dirname(fileURLToPath(import.meta.url));

/** 評価器が通せるようになったファイル。段階が進むたびにここへ足す。 */
const COVERED = [
  'literals.txt',
  'messages.txt',
  'precedence.txt',
  'errors.txt',
  'numbers.txt',
  'strings.txt',
  'booleans.txt',
  'blocks.txt',
  'conditionals.txt',
  'collections.txt',
  'references.txt',
  // 範囲とセルへの代入は M3 / M4 のものだが、**構文として拒む側は評価器だけで判定できる。**
  // どちらのファイルも「範囲にならない書き方」「数式に代入は書けない」を検査するケースを
  // 持っており、対象に入れないとその分が回帰検査の外に残る。
  // 中身を評価するケースには `!pending` が付いているので、通ってしまえば赤になる。
  'ranges.txt',
  'assignment.txt',
];

/** ゴールデンテストの入力を評価器に渡す。マクロとシートはまだ無い。 */
const evaluate = ({ source, sheet, kind }) => {
  if (kind === 'macro') throw new Error('未実装: マクロの評価はまだできません。');
  if (sheet.size > 0) throw new Error('未実装: シートの状態はまだ扱えません。');
  return printValue(evaluateFormula(source).value);
};

describe('ゴールデンテストの評価', () => {
  it.each(COVERED)('%s が仕様どおりに評価される', (file) => {
    const cases = parseGoldenFile(readFileSync(join(goldenDir, file), 'utf8'), file);

    // 全ケースが保留になっていれば、このファイルは何も検査していない。
    // 印の付け過ぎを「緑」と見分けられなくなるので、ここで落とす。
    expect(cases.some((testCase) => testCase.pending === null)).toBe(true);

    const failures = runGoldenCases(cases, evaluate);
    if (failures.length > 0) expect.fail(formatGoldenFailures(failures, file));
  });
});
