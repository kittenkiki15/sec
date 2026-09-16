/**
 * シートのセルの値（仕様書 §4.2）。**内容の解釈（§4.4）を値に変える段。**
 *
 * シートは原文しか持たない（`sheet.ts`）。そこから値を出す規則は §4.4 が 3 段で定めており、
 * **どの段に落ちるかを決めるのが `readContent`、その結果を値にするのがここ**である。
 *
 * **数式セルはまだ値にできない。** 数式の中のセル参照が他のセルの値を要求するので、
 * 依存グラフと再計算の順序が要る（要件 F-4、M3 段階 5）。
 */

import { NotImplementedError } from '../eval/evaluate.ts';
import { type CellValues, type HeldValue, heldValue } from '../eval/value.ts';
import { readContent } from './content.ts';
import type { Sheet } from './sheet.ts';

/** 空セルの値（[ADR-0010](../../../../docs/adr/0010-empty-cell-value.md)）。 */
const NIL: HeldValue = { kind: 'nil' };

/**
 * シートのセルの値を答える関数を作る。
 *
 * **シートを直に渡さず関数にするのは、数式セルの値が再計算の結果だからである**（要件 F-4）。
 * 段階 5 では再計算エンジンが同じ形の関数を差し出し、評価器の側は変わらない。
 *
 * @param sheet セルの内容を持つシート
 * @returns 番地からそのセルが保持する値を答える関数
 * @throws {NotImplementedError} 数式を持つセルの値を求めようとした場合（M3 段階 5）
 */
export function sheetValues(sheet: Sheet): CellValues {
  return (address) => {
    const content = readContent(sheet.contentAt(address));
    switch (content.kind) {
      case 'empty':
        return NIL;
      // **内容の解釈が返すのはリテラルの値なので、セルであることはない**（`HeldValue`）。
      // 型の上でそれを言えないだけなので、同じ解決を通して潰す。
      case 'value':
        return heldValue(content.value);
      case 'formula':
        throw new NotImplementedError('数式を持つセル');
    }
  };
}
