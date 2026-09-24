/**
 * セルに書き込む値を内容（原文）にする（仕様書 §7.4、[ADR-0027](../../../../docs/adr/0027-macro-execution.md) の案 E）。
 *
 * **セルは内容を持つもので、値を直接は持たない**（要件 F-5-1）。値は §0.3 の表記で内容にし、
 * §4.4 の読み方（`readContent`）で同じ値に戻す。**表記を 2 つ作らない**ために `printValue` を使い、
 * ここでは「表記してよい値か」だけを決める。
 */

import { type ErrorValue, heldValue, printValue, type Value } from './value.ts';

const TYPE_ERROR: ErrorValue = { kind: 'error', error: 'TypeError' };

/**
 * 値を、セルに置く内容にする。
 *
 * | 値 | 内容 |
 * | --- | --- |
 * | `nil` | 空文字列。**セルを空にする**（ADR-0010） |
 * | `Cell` | 保持する値の内容。**配列の要素でも同じ**（利用者の選択） |
 * | ブロック・範囲・区間 | `#TypeError`。リテラルで書けない |
 * | エラー、エラーを要素に持つ配列 | そのエラー。**エラーを値としてセルに残さない** |
 * | それ以外 | §0.3 の表記。文字列は引用符付きなので、数や数式に読まれない |
 *
 * @returns 内容の原文。**置けない値ならエラー**で、そのときは何も書き込まない
 */
export function contentToWrite(value: Value): string | ErrorValue {
  const literal = asLiteral(value);
  if (literal.kind === 'error') return literal;
  // 配列の要素の `nil` は `#(nil)` と書けるが、最上位の `nil` を `'nil'` と置くと
  // 空のセルと空でないセルの 2 通りの `nil` ができてしまう。
  return literal.kind === 'nil' ? '' : printValue(literal);
}

/**
 * 値をリテラルとして書ける形にする。**セルは保持する値に置き換える。**
 *
 * **配列の要素も同じ規則で辿る。** 範囲の列挙が渡すのは `Cell` なので（§6.3、ADR-0015）、
 * `collect:` の結果はセルを要素に持ちうる。表記は値に従うので `#(1 2)` と書けてしまうが、
 * 読み戻すと値の配列になる。**最上位のセルを値にして置くのと同じ扱い**にそろえた。
 *
 * @returns セルを含まない値。書けなければエラー（**最初に見つかったもの**、§6.0）
 */
function asLiteral(value: Value): Value {
  switch (value.kind) {
    case 'integer':
    case 'decimal':
    case 'string':
    case 'symbol':
    case 'boolean':
    case 'nil':
    case 'error':
      return value;
    case 'cell':
      return asLiteral(heldValue(value));
    case 'array': {
      const elements: Value[] = [];
      for (const element of value.elements) {
        const literal = asLiteral(element);
        // `#(1.0e400)` の表記 `#(#Overflow)` はシンボルの配列として読み戻され、別の値になる。
        if (literal.kind === 'error') return literal;
        elements.push(literal);
      }
      return { kind: 'array', elements };
    }
    case 'block':
    case 'range':
    case 'interval':
      return TYPE_ERROR;
  }
}
