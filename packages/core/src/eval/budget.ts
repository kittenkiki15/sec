/**
 * 実行上限（要件 N-5、仕様書 §7.8、CLAUDE.md の規約 4、ADR-0033）。
 *
 * **数えるのはステップ数と再帰深度だけである。** 時間を見ないのは、マシンの速度で結果が
 * 変わると決定性（要件 F-4-4）を満たさず、**`#Timeout` になるケースをゴールデンテストに
 * 書けなくなる**ため。時刻を読む経路を評価器に作らずに済むのも同じ理由（規約 5）。
 * 時間の上限はホストが掛ける（ADR-0027）。
 */

/** 1 回の評価で使えるステップ数（ADR-0033）。数式とマクロで同じ（§7.8）。 */
export const STEP_LIMIT = 1_000_000n;

/**
 * 評価の入れ子の深さの上限（ADR-0033）。最上位の式が深さ 1 で、受け手・引数・配列の要素は
 * 1 段深く、ブロックの本体の文は起動した送信より 1 段深い（§7.8）。
 *
 * **値はスタックが尽きる深さより十分に浅く取ってある。** 1 段が JavaScript の何段になるかは
 * 評価器が本体を呼び戻す経路で違い、最も深い経路（`sorted:` の比較から潜る再帰）で
 * 約 490 段で尽きた（Node 22）。上限がスタックより先に当たらなければ、止まる深さが
 * スタックと JIT の状態で揺れ、同じ原文の結果が実行ごとに変わる。
 */
export const DEPTH_LIMIT = 256;

/**
 * 1 回の評価が使える予算。**評価ごとに作り直す**ので、使い切った評価が次に影響しない。
 *
 * ステップ数の個数を `bigint` で持つのは、区間の要素数が任意精度だからである（ADR-0016）。
 * `1 to: 1e400` の個数は倍精度に収まらないが、**予算と比べるだけなら精度を落とさずに済む。**
 */
export class EvaluationBudget {
  #remaining: bigint;
  #depth = 0;

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

  /**
   * 1 段深く潜る。**潜れたら必ず `leave` で戻る**（例外で抜けるときも）。
   *
   * @returns 潜れたか。**`false` なら上限を超える**ので、潜らずに `#Timeout` にする
   */
  enter(): boolean {
    if (this.#depth >= DEPTH_LIMIT) return false;
    this.#depth += 1;
    return true;
  }

  /** `enter` で潜った段から戻る。 */
  leave(): void {
    this.#depth -= 1;
  }
}
