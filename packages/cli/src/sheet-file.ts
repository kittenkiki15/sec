/**
 * `sec run` が読み書きするシートの JSON。**`.secbook`（要件 F-5-1、M7）ができるまでの仮の形**
 * （[ADR-0034](../../../docs/adr/0034-sec-run.md)）。
 *
 * ```json
 * { "A1": "3", "B1": "=A1 * 2" }
 * ```
 *
 * 番地から**内容の原文**への対応で、値は持たない。値は原文から導かれる（`Sheet` と同じ向き）。
 * 読むものと書くものを同じ形にしてあるので、`--out` の出力をそのまま次の `--sheet` に渡せる。
 */

import {
  type CellAddress,
  compareColumns,
  isResolvable,
  parseAddress,
  printAddress,
} from '@sec/core/model';

/** 番地と内容の原文の組の列。**空のセルは含めない**（ADR-0010）。 */
export type SheetCells = readonly (readonly [CellAddress, string])[];

/**
 * シートの JSON を読む。**誤りは 1 つ目で止めて、理由を返す。**
 *
 * **内容は文字列に限る。** 数を受けると、`3` を数として置いたのか `'3'` のつもりだったのかが
 * 曖昧になる（内容の解釈は ADR-0021 が原文に対して定めている）。
 *
 * @returns セルの列。番地は正規化してある（ADR-0020）
 */
export function readSheetFile(text: string): { cells: SheetCells } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: `JSON として読めません（${(error as Error).message}）。` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: '最上位は番地から内容へのオブジェクトにしてください。' };
  }

  const cells: [CellAddress, string][] = [];
  const seen = new Map<string, string>();
  for (const [spelling, content] of Object.entries(parsed)) {
    const address = parseAddress(spelling);
    if (address === null || !isResolvable(address)) {
      return { error: `"${spelling}" はシートにある番地ではありません。` };
    }
    // 正規化すると同じセルになる綴りは、どちらかが黙って消える（ADR-0020）。
    const key = printAddress(address);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      return { error: `"${earlier}" と "${spelling}" は同じセル ${key} です。` };
    }
    seen.set(key, spelling);

    if (typeof content !== 'string') {
      return { error: `${spelling} の内容は文字列にしてください（数式も値も原文で書きます）。` };
    }
    if (content !== '') cells.push([address, content]);
  }
  return { cells };
}

/**
 * シートの JSON を書く。**行を先に、列を後に並べる。** 置いた順のままだと、
 * マクロが書き込んだ順が見た目に出て、同じシートでも差分が出てしまう。
 */
export function printSheetFile(cells: SheetCells): string {
  const entries = [...cells]
    .sort(([left], [right]) => compareAddresses(left, right))
    .map(([address, content]) => [printAddress(address), content]);
  return `${JSON.stringify(Object.fromEntries(entries), null, 2)}\n`;
}

/** 行を先に、列を後に比べる。 */
export function compareAddresses(left: CellAddress, right: CellAddress): number {
  if (left.row !== right.row) return left.row < right.row ? -1 : 1;
  return compareColumns(left.column, right.column);
}
