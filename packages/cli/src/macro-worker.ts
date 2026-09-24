/**
 * `sec run` のマクロを走らせる Worker。**依頼を 1 つ受けて結果を 1 つ返す。**
 *
 * マクロを別のスレッドに置くのは、**時間の上限を超えたら Worker ごと捨てる**ためである
 * （ADR-0027）。`core` は時刻を読まないので、止まらない処理を中から止める手段が無い。
 */

import { parentPort } from 'node:worker_threads';
import { executeMacro, type MacroRequest } from './macro.ts';

parentPort?.once('message', (request: MacroRequest) => {
  parentPort?.postMessage(executeMacro(request));
});
