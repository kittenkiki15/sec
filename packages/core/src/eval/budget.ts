/**
 * 実行上限（要件 N-5、仕様書 §7.8、CLAUDE.md の規約 4）。
 *
 * **数えるのはステップ数だけである。** 時間を見ないのは、マシンの速度で結果が変わると
 * 決定性（要件 F-4-4）を満たさず、**`#Timeout` になるケースをゴールデンテストに
 * 書けなくなる**ため。時刻を読む経路を評価器に作らずに済むのも同じ理由（規約 5）。
 * 再帰深度は `evaluateFormula` が `RangeError` を受け止める安全網が既に持っている。
 *
 * **上限値は暫定である。** §7.8 は「環境によって妥当な値が違う」として、要件 N-1〜N-3 の
 * 性能目標と併せて M4 で決めるとしている。ここにあるのは**必ず止まることを保証する機構**
 * であって、値の決定ではない（[#27](https://github.com/kittenkiki15/sec/issues/27)）。
 */

/** 1 回の評価で使えるステップ数。**暫定値**で、M4 で決め直す（#27）。 */
export const STEP_LIMIT = 1_000_000n;

/**
 * 1 回の評価が使える予算。**評価ごとに作り直す**ので、使い切った評価が次に影響しない。
 *
 * 個数を `bigint` で持つのは、区間の要素数が任意精度だからである（ADR-0016）。
 * `1 to: 1e400` の個数は倍精度に収まらないが、**予算と比べるだけなら精度を落とさずに済む。**
 */
export class StepBudget {
  #remaining: bigint;

  constructor(limit: bigint = STEP_LIMIT) {
    this.#remaining = limit;
  }

  /**
   * ステップを使う。
   *
   * **まとめて払えるようにしてある。** 列挙は要素の数を先に知っているので、
   * `1 to: 1e400` のような区間を 1 歩ずつ数えることなく、並べる前に打ち切れる。
   *
   * @param steps 使うステップ数
   * @returns 足りたか。**`false` なら尽きている**（呼び出し側が `#Timeout` にする）
   */
  spend(steps: bigint = 1n): boolean {
    if (steps > this.#remaining) return false;
    this.#remaining -= steps;
    return true;
  }
}
