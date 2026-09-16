/**
 * セルの内容の解釈（[ADR-0021](../../../../docs/adr/0021-cell-content-interpretation.md)、仕様書 §4.4）。
 *
 * **セルが持つのは原文テキストである**（要件 F-5-1）。そこから何を読み取るかを 3 段で決める。
 *
 * | 順 | 条件 | 結果 |
 * | --- | --- | --- |
 * | 1 | 内容が `=` で始まる | 残りが数式の原文（要件 F-2-1） |
 * | 2 | 内容が §2 のリテラルちょうど 1 つとして読める | そのリテラルの値 |
 * | 3 | それ以外 | 内容をそのまま持つ文字列 |
 *
 * **段 2 に入るかどうかは構文で決まり、値がエラーかどうかは関わらない。**
 * `1.0e400` は §2.1 の形に合うので段 2 に入り、値は `#Overflow` になる（ADR-0013）。
 * 文字列 `'1.0e400'` にはならない。
 */

import { evaluateLiteral } from '../eval/evaluate.ts';
import type { Value } from '../eval/value.ts';
import { LexicalError } from '../syntax/lexer.ts';
import { type Expression, type LiteralNode, ParseError, parseFormula } from '../syntax/parser.ts';

/**
 * セルの内容から読み取れるもの。
 *
 * **数式を値にせず、原文のまま返す。** 評価にはシートの他のセルが要る（§4.2）ので、
 * ここで抱えると内容の解釈が再計算を知ることになる。**値を出すのは再計算の側の仕事**で、
 * この関数は「何として読むか」だけを決める。
 */
export type CellContent =
  /** 空のセル。値は `nil`（[ADR-0010](../../../../docs/adr/0010-empty-cell-value.md)）。 */
  | { readonly kind: 'empty' }
  /** 数式。`=` を外した残りが原文。**空のこともある**（内容が `=` だけのとき）。 */
  | { readonly kind: 'formula'; readonly source: string }
  /** 数式によらずに決まる値。定数セルの値である。 */
  | { readonly kind: 'value'; readonly value: Value };

/** 数式の始まり（要件 F-2-1）。 */
const FORMULA_PREFIX = '=';

/**
 * セルの内容を読む。
 *
 * **段 1 は原文の 1 文字目だけを見る**（利用者の選択）。`  =A1 + 1` は数式にならず
 * 文字列になる。前後の空白を無視してから `=` を探すと、**打ち間違えた空白が黙って
 * 数式を殺す**代わりに、数式かどうかが原文の見た目どおりに決まる。表計算の慣習とも揃う。
 *
 * **空セルは原文が空文字列のときだけ**（利用者の選択）。空白だけの内容は段 3 に落ちて
 * 文字列になる。段 2 が前後の空白を無視するのは §1.1 の字句の規則であって、
 * **内容が空かどうかの判定ではない。**
 *
 * @param content セルの内容の原文
 * @returns 内容を何として読むか
 */
export function readContent(content: string): CellContent {
  if (content === '') return { kind: 'empty' };

  if (content.startsWith(FORMULA_PREFIX)) {
    return { kind: 'formula', source: content.slice(FORMULA_PREFIX.length) };
  }

  // 段 2 で読めなければ段 3。**途中まで読めた分は採らない**（ADR-0021）。
  // 部分一致を許すと、`1 abc` が `1` になるか `'1 abc'` になるかを別途決めることになる。
  return { kind: 'value', value: readLiteral(content) ?? { kind: 'string', value: content } };
}

/**
 * 内容を §2 のリテラルちょうど 1 つとして読む。
 *
 * **構文解析器に読ませる。** リテラルの形を判定する規則をここに書き写すと、§2 を直した
 * ときに片方だけ古くなる（`asNumber` を字句解析器に読ませたのと同じ理由）。
 *
 * @returns リテラルの値。リテラル 1 つとして読めなければ `null`
 */
function readLiteral(content: string): Value | null {
  let node: Expression;
  try {
    node = parseFormula(content);
  } catch (error) {
    // **読めないことと、読み方そのものが壊れていることを混同しない。**
    // 前者は段 3 へ落とす合図だが、後者は実装の誤りなので握り潰さず外へ出す。
    if (error instanceof LexicalError || error instanceof ParseError) return null;
    throw error;
  }

  const literal = asLiteral(node);
  return literal === null ? null : evaluateLiteral(literal);
}

/**
 * 式がリテラルそのものか。**セル参照も裸の識別子もリテラルではない**（§2）ので、
 * `A1` と打った内容は文字列になる。
 *
 * **`default` を置かずに全種別を並べてある。** ノードの種別が増えたとき、
 * ここが返り値を持たない経路として型検査に落ちる（黙って段 3 に流れない）。
 */
function asLiteral(node: Expression): LiteralNode | null {
  switch (node.kind) {
    case 'integer':
    case 'decimal':
    case 'string':
    case 'symbol':
    case 'boolean':
    case 'nil':
    case 'array':
    // 倍精度に収まらない小数（§2.1、ADR-0013）。**リテラルとして読めている**ので段 2。
    case 'error':
      return node;
    case 'identifier':
    case 'cell':
    case 'block':
    case 'send':
      return null;
  }
}
