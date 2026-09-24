/**
 * マクロを Worker で走らせ、時間の上限を掛ける（ADR-0027）。
 *
 * **実際に Worker を起動する。** 打ち切りは Worker を捨てることで成り立つので、
 * 差し替えた実行では確かめられない。
 */

import { describe, expect, it } from 'vitest';
import { runMacroInWorker } from './worker-host.ts';

describe('マクロを Worker で走らせる', () => {
  it('上限の中で終われば、その結果を返す', async () => {
    const outcome = await runMacroInWorker({ source: '^ 3 + 4', cells: [], send: null }, 5000);
    expect(outcome).toMatchObject({ kind: 'ran', value: '7' });
  });

  // ステップ数の上限（§7.8）でも止まるが、それは `ran` の `#Timeout` になる。
  // **時間で打ち切ったことは種別で見分ける。** 1ms は Worker の起動にも足りない。
  it('時間の上限を超えたら打ち切る', async () => {
    const outcome = await runMacroInWorker(
      { source: '[true] whileTrue: [1]', cells: [], send: null },
      1,
    );
    expect(outcome).toEqual({ kind: 'timedOut' });
  });
});
