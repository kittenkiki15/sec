/**
 * 評価器。構文解析器が組んだ AST を値にする。
 *
 * **ここが決めるのは評価の順序**（仕様書 §3.6）で、受け手 → 引数を左から右 → 送信。
 * すべての引数は送信の前に評価される（先行評価）。**遅延評価はブロックで表す**（要件 F-2-9）。
 * 1 回の送信の中でどう検査するかは `send.ts` が引き受ける。
 *
 * **セル参照（M3）とマクロ（M4）、およびどこにも束縛されていない識別子はまだ評価できず、
 * 例外になる。** ゴールデンテストの側はそれらのケースに `!pending` の印を付けてある
 * （ADR-0019）。束縛されていない識別子を §4.2 の `#Ref` にするのは、
 * セル参照が解決できるようになってからでよい（`references.txt` が M3 待ちである）。
 *
 * **エラーは値として返し、例外にしない**（要件 F-8-1）。例外にすると評価の途中で制御が飛び、
 * §6.0 の伝播順序（受け手 → 引数を左から右 → 送信）を値の受け渡しで表せなくなる。
 * **例外を使うのは「まだ実装が無い」ことを言うときだけ**で、これは仕様上の状態ではない。
 */

import { LexicalError } from '../syntax/lexer.ts';
import {
  type Expression,
  type LiteralNode,
  ParseError,
  parseFormula,
  type SendNode,
} from '../syntax/parser.ts';
import { sendMessage } from './send.ts';
import type { BlockValue, Environment, ReceivedValue, Value } from './value.ts';

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
  try {
    // 数式の最上位に束縛は無い。名前を導入できるのはブロックの引数だけである（§5.1）。
    return evaluate(parseFormula(source), EMPTY_ENVIRONMENT);
  } catch (error) {
    if (error instanceof LexicalError || error instanceof ParseError) {
      return { kind: 'error', error: 'Syntax' };
    }
    // 深い入れ子は構文解析器と評価器のどちらの再帰も尽きさせうる。**どちらで尽きても
    // 仕様外の例外を漏らさない。** 超過した評価は `#Timeout`（§7.8）。
    //
    // **これは明示的な上限ではなく安全網である。** 本来はステップ数・時間・再帰深度を
    // 予算として持つべきで（要件 N-5、CLAUDE.md 規約 4）、上限値は環境によって
    // 妥当な値が違うため §7.8 が M4 送りにしている（#27）。
    // それまでの間、呼び出し元が値だけを受け取れる状態を保つ。
    if (error instanceof RangeError) {
      return { kind: 'error', error: 'Timeout' };
    }
    throw error;
  }
}

const EMPTY_ENVIRONMENT: Environment = new Map();

/**
 * リテラル配列の要素は式ではなくリテラルなので（§2.4）、同じ経路で値にできる。
 *
 * @param environment その位置で見えている束縛（§5.1）。ブロックの引数だけが入る
 */
function evaluate(node: Expression | LiteralNode, environment: Environment): Value {
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
      // リテラル配列の要素に識別子は現れない（§2.4）が、経路を分けない方が安い。
      return {
        kind: 'array',
        elements: node.elements.map((element) => evaluate(element, environment)),
      };
    // 構文解析の段階で生じたエラー（倍精度に収まらない小数）。木に載っているものを
    // そのまま値にする（ADR-0013）。構文エラーではないので #Syntax ではない。
    case 'error':
      return { kind: 'error', error: node.error };
    // **ブロックは作るだけでは本体を評価しない**（§5.1）。木のまま値に載せ、
    // `value` を送られたときに `invokeBlock` が評価する。
    case 'block':
      return { kind: 'block', parameters: node.parameters, body: node, environment };
    case 'send':
      return evaluateSend(node, environment);
    case 'cell':
      throw new NotImplementedError('セル参照');
    // 束縛されている識別子はブロックの引数（§5.1）。**それ以外は §4.2 が `#Ref` と
    // 定めているが、セル参照が解決できない今はまだ実装しない**（M3）。
    case 'identifier': {
      const bound = environment.get(node.name);
      if (bound === undefined) throw new NotImplementedError('束縛されていない識別子');
      return bound;
    }
  }
}

/**
 * §3.6 の評価順序をそのまま書いたもの。**受け手 → 引数を左から右 → 送信。**
 *
 * **最初に生じたエラーがその式全体の値になり、それ以降は評価しない**（§6.0、ADR-0011）。
 * エラーの種別に強弱は無く、決めるのは順序だけである。打ち切りをここに集めてあるので、
 * **エラーが受け手や引数として送信まで届くことはない**（`ReceivedValue` がそれを表す）。
 */
function evaluateSend(node: SendNode, environment: Environment): Value {
  const receiver = evaluate(node.receiver, environment);
  if (receiver.kind === 'error') return receiver;

  const args: ReceivedValue[] = [];
  for (const argument of node.arguments) {
    const value = evaluate(argument, environment);
    if (value.kind === 'error') return value;
    args.push(value);
  }

  return sendMessage(receiver, node.selector, args, invokeBlock);
}

/**
 * ブロックの本体を評価する。**数式のブロックの本体は式ちょうど 1 つ**（§5.1）。
 * 代入が書けない以上、一時変数を宣言しても使い道が無く、文を並べる意味も無いためである。
 *
 * 文の列と一時変数を持てるのはマクロのブロックで（§7.5）、`parseFormula` はそれを弾く。
 * **弾かれた形がここへ来ることはないが、木の型は両方を許す**ので、来たときは
 * 未実装として扱う。黙って別の値を返さないのはリテラル以外のノードと同じ理由。
 *
 * **引数の数の検査をここに置いた**（§5.1）。`value:` の送信だけでなく、条件式が
 * ブロックを引数なしで評価する経路（§5.2）にも同じ規則が当たる必要があるためで、
 * 呼び出しの側それぞれに書くと**足し忘れた 1 つが検査を抜ける。**
 *
 * @param args 引数に束ねる値。セレクタの綴りが数を決める（`value:value:` なら 2 つ）
 */
function invokeBlock(block: BlockValue, args: readonly ReceivedValue[]): Value {
  const environment = bindParameters(block, args);
  if (environment === null) return { kind: 'error', error: 'TypeError' };

  const [statement] = block.body.statements;
  if (
    statement === undefined ||
    block.body.statements.length !== 1 ||
    block.body.temporaries.length > 0 ||
    statement.kind === 'assign' ||
    statement.kind === 'return'
  ) {
    throw new NotImplementedError('マクロのブロック');
  }

  return evaluate(statement, environment);
}

/**
 * ブロックが捕まえた環境に引数を重ねる。**名前が衝突することはない**（外側と同じ名前は
 * 宣言できず、構文解析器が既に弾いている）ので、上書きの向きを考えずに済む。
 *
 * @returns 本体を評価する環境。**引数の数が合わなければ `null`**（§5.1 の `#TypeError`）
 */
function bindParameters(block: BlockValue, args: readonly ReceivedValue[]): Environment | null {
  if (block.parameters.length !== args.length) return null;
  if (args.length === 0) return block.environment;

  const bindings = new Map(block.environment);
  for (const [index, value] of args.entries()) {
    const name = block.parameters[index];
    // 数が合うことは上で確かめてあるので、ここへは来ない。
    if (name === undefined) return null;
    bindings.set(name, value);
  }
  return bindings;
}
