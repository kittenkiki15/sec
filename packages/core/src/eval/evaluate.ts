/**
 * 評価器。構文解析器が組んだ AST を値にする。
 *
 * **段階 1 はリテラルだけを扱う**（[#25](https://github.com/kittenkiki15/sec/issues/25)）。
 * メッセージ送信・ブロック・セル参照はまだ評価できず、例外になる。
 * ゴールデンテストの側はそれらのケースに `!pending` の印を付けてある（ADR-0019）。
 *
 * **エラーは値として返し、例外にしない**（要件 F-8-1）。例外にすると評価の途中で制御が飛び、
 * §6.0 の伝播順序（受け手 → 引数を左から右 → 送信）を値の受け渡しで表せなくなる。
 * **例外を使うのは「まだ実装が無い」ことを言うときだけ**で、これは仕様上の状態ではない。
 */

import { LexicalError } from '../syntax/lexer.ts';
import { type Expression, type LiteralNode, ParseError, parseFormula } from '../syntax/parser.ts';
import type { Value } from './value.ts';

/** まだ評価できないノードに当たったことを表す。**仕様上のエラーではない。** */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`未実装: ${what}の評価はまだできません。`);
    this.name = 'NotImplementedError';
  }
}

/**
 * 数式の原文を評価する。
 *
 * **字句エラーと構文エラーはどちらも `#Syntax` の値になる。** 利用者から見ると
 * 区別が無いためで（§0.3）、構文エラーは評価より前に決まるので常に実行時のエラーより先に出る。
 * **`LexicalError` と `ParseError` はクラスとしては分けたまま**にした。
 * どちらも位置と説明文を持つが、字句の段階か構文の段階かは報告する側に要る（要件 F-8-3）。
 *
 * @param source 数式の原文（セルの `=` は含めない）
 * @returns 評価結果。エラーも値として返る
 * @throws {NotImplementedError} まだ評価できないノードに当たった場合
 */
export function evaluateFormula(source: string): Value {
  let tree: Expression;
  try {
    tree = parseFormula(source);
  } catch (error) {
    if (error instanceof LexicalError || error instanceof ParseError) {
      return { kind: 'error', error: 'Syntax' };
    }
    throw error;
  }
  return evaluate(tree);
}

/** リテラル配列の要素は式ではなくリテラルなので（§2.4）、同じ経路で値にできる。 */
function evaluate(node: Expression | LiteralNode): Value {
  switch (node.kind) {
    case 'integer':
      return { kind: 'integer', value: node.value };
    case 'decimal':
      return { kind: 'decimal', value: node.value };
    case 'string':
      return { kind: 'string', value: node.value };
    case 'symbol':
      return { kind: 'symbol', value: node.value };
    case 'boolean':
      return { kind: 'boolean', value: node.value };
    case 'nil':
      return { kind: 'nil' };
    case 'array':
      return { kind: 'array', elements: node.elements.map(evaluate) };
    // 構文解析の段階で生じたエラー（倍精度に収まらない小数）。木に載っているものを
    // そのまま値にする（ADR-0013）。構文エラーではないので #Syntax ではない。
    case 'error':
      return { kind: 'error', error: node.error };
    case 'send':
      throw new NotImplementedError('メッセージ送信');
    case 'block':
      throw new NotImplementedError('ブロック');
    case 'cell':
      throw new NotImplementedError('セル参照');
    case 'identifier':
      throw new NotImplementedError('識別子');
  }
}
