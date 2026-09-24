/**
 * マクロを Worker で走らせ、**時間の上限を掛ける**（要件 F-3-5、ADR-0027）。
 *
 * 超えたら Worker ごと捨てる。**書き込みは Worker の中のシートにしか届いていない**ので、
 * 捨てれば何も反映されず、巻き戻しはそれで成り立つ。
 */

import { Worker } from 'node:worker_threads';
import type { MacroOutcome, MacroRequest } from './macro.ts';

/** 時間の上限を超えて打ち切った。 */
export interface TimedOut {
  readonly kind: 'timedOut';
}

/**
 * マクロを Worker で走らせる。
 *
 * **時間は Worker を起こしたときから数える。** 起動の時間を除くと、起動が遅い環境で
 * 上限より長く待つことになる。既定の 5 秒に対して起動は数十ミリ秒で、差は問題にならない。
 *
 * @param timeoutMs 時間の上限（ミリ秒）
 */
export function runMacroInWorker(
  request: MacroRequest,
  timeoutMs: number,
): Promise<MacroOutcome | TimedOut> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./macro-worker.ts', import.meta.url));
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      worker.removeAllListeners();
      // 結果を受け取った後も捨てる。**残すとイベントループが終わらず、`sec` が終了しない。**
      void worker.terminate();
      finish();
    };

    const timer = setTimeout(() => settle(() => resolve({ kind: 'timedOut' })), timeoutMs);
    worker.once('message', (outcome: MacroOutcome) => settle(() => resolve(outcome)));
    // 評価器の外の例外（実装の誤り）は握りつぶさずに投げる。
    worker.once('error', (error) => settle(() => reject(error)));
    worker.once('exit', (code) =>
      settle(() => reject(new Error(`マクロの Worker が結果を返さずに終了しました（${code}）。`))),
    );
    worker.postMessage(request);
  });
}
