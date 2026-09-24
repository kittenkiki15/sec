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
import { evaluateFormula, evaluateMacro, printValue } from '../../packages/core/src/eval/index.ts';
import {
  LiveSheet,
  parseAddress,
  recalculate,
  Sheet,
} from '../../packages/core/src/model/index.ts';
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
  // マクロは M4 のものだが、**同じ原文を数式として読めば拒む**ケースを持っている（§7.7）。
  // 対象に入れないとその分が回帰検査の外に残る。マクロのケースには `!pending` が付いている。
  'macros.txt',
];

/**
 * ケースのセルの指定（`!A1 := 1`、ADR-0009）からシートを組む。
 *
 * **番地は正規化される**（ADR-0020）ので、`!A007 := 1` は `A7` のセルになる。
 */
const addressed = (cells) =>
  [...cells].map(([spelling, content]) => {
    const address = parseAddress(spelling);
    // ハーネスが綴りを検査済み（`parseGoldenFile`）なので、ここへは来ない。
    if (address === null) throw new Error(`${spelling} はセル参照の形ではありません。`);
    return [address, content];
  });

const buildSheet = (cells) => {
  const sheet = new Sheet();
  for (const [address, content] of addressed(cells)) sheet.put(address, content);
  return sheet;
};

/**
 * ゴールデンテストの入力を評価器に渡す。
 *
 * **マクロは本体だけを評価できる**（M4 段階 1）。宣言部を持つ定義の起動（`!macro from: 1 to: 3`）は
 * 段階 6 のもので、そのケースには `!pending` が付いている。
 *
 * **マクロはセルに書き込む**（§7.4）ので、値を保つだけでなく書き込みを下流に伝えるシートを渡す。
 */
const evaluate = ({ source, sheet, kind, send }) => {
  if (kind === 'formula') {
    return printValue(evaluateFormula(source, recalculate(buildSheet(sheet))).value);
  }
  if (send !== null) throw new Error('未実装: マクロの起動はまだできません。');
  return printValue(evaluateMacro(source, new LiveSheet(addressed(sheet))).value);
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
