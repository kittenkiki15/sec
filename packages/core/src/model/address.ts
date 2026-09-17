/**
 * セルの番地（[ADR-0020](../../../../docs/adr/0020-cell-address-normalization.md)、仕様書 §4.1）。
 *
 * **番地は「列の綴り + 行の数値」であって、原文の綴りではない。** `A007` と `A7` は
 * 同じ 1 つのセルを指す。シートはこの番地をキーにするので、**「同じセルか」の判定が
 * ここで決まる。**
 *
 * **行を `bigint` で持つのは §4.1 が桁数を制限していないため**（値の整数を任意精度に
 * したのと同じ理由、ADR-0012）。**列は正規化しない。** 双射基数 26（`Z` の次が `AA`）は
 * 前ゼロにあたる綴りを持たないので、正規化する余地がそもそも無い。
 */

/** セルの番地。**列は大文字の綴り、行は 1 始まりの十進数**（§4.1）。 */
export interface CellAddress {
  readonly column: string;
  readonly row: bigint;
}

/** §4.1 の列の形。**1 箇所から組み立てる**ので、下の 2 つが食い違うことがない。 */
const COLUMN = '[A-Z]+';

/** 列の綴りそのもの。手で組み立てた番地の検査に使う（`isResolvable`）。 */
const COLUMN_SPELLING = new RegExp(`^${COLUMN}$`);

/** §4.1 のセル参照の形。列と行を切り出すために、字句規則を群に分けて写したもの。 */
const CELL_REFERENCE = new RegExp(`^(${COLUMN})([0-9]+)$`);

/**
 * 綴りを番地として読む。
 *
 * **行 0 も番地として読む。** 形としてはセル参照であり（§4.1）、
 * **解決できないこと（`#Ref`）は §4.2 の別の規則である**（`isResolvable`）。
 * ここで弾くと「形が違う」と「指す先が無い」を呼び出し側が区別できなくなる。
 *
 * @param spelling 原文の綴り（`A1`、`AB12`、`A007`）
 * @returns 正規化した番地。セル参照の形でなければ `null`
 */
export function parseAddress(spelling: string): CellAddress | null {
  const matched = CELL_REFERENCE.exec(spelling);
  if (matched === null) return null;

  const [, column, row] = matched;
  if (column === undefined || row === undefined) return null;

  // 前ゼロはここで落ちる。`BigInt('007')` は `7n`（ADR-0020）。
  return { column, row: BigInt(row) };
}

/**
 * 番地を綴りにする。**正規化した後の綴りであり、原文ではない。**
 * 範囲の表記（`A1 to: B10`、§4.3）の両端もこの綴りで書く（ADR-0020）。
 */
export function printAddress(address: CellAddress): string {
  return `${address.column}${address.row}`;
}

/**
 * その番地のセルがシートに存在しうるか。
 *
 * **行は 1 始まり**（要件 F-1-3）。**正規化した結果が 0 なら解決できない**（ADR-0020）ので、
 * `A0` も `A000` も `#Ref` になる（§4.2）。
 *
 * **列の綴りも検査する。** 番地は構造型なので、呼び出し側は `parseAddress` を通さずに
 * `{ column: 'A1', row: 2n }` のような値を組み立てられる。`printAddress` は連結するだけなので、
 * **これを通すとシートのキーが `A12` になり、別のセルと衝突する**（AI レビューの指摘）。
 */
export function isResolvable(address: CellAddress): boolean {
  return COLUMN_SPELLING.test(address.column) && address.row > 0n;
}

/**
 * 列の綴りの大小。**範囲の正規化（§4.3）が要る。**
 *
 * **辞書順ではない。** 列は双射基数 26（`Z` の次が `AA`）なので、
 * 綴りが長い列ほど右にある。辞書順で比べると `AA` が `Z` より先になり、
 * **`AA1 to: Z1` が矩形を裏返したまま正規化される。**
 *
 * @returns 左が先なら `-1`、右が先なら `1`、同じ列なら `0`
 */
export function compareColumns(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
