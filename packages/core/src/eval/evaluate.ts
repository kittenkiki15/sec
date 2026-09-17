/**
 * 評価器。構文解析器が組んだ AST を値にする。
 *
 * **ここが決めるのは評価の順序**（仕様書 §3.6）で、受け手 → 引数を左から右 → 送信。
 * すべての引数は送信の前に評価される（先行評価）。**遅延評価はブロックで表す**（要件 F-2-9）。
 * 1 回の送信の中でどう検査するかは `send.ts` が引き受ける。
 *
 * **セル参照は `Cell` に評価され、理解しないメッセージは保持する値へ委譲される**
 * （§4.2、ADR-0008）。**委譲の規則 1 と規則 2 は `evaluateSend` が持ち、**
 * `Cell` 自身が理解するセレクタは `sendToCell` にある。
 * **範囲（§4.3）まで評価できる。** まだ評価できないのは数式を持つセル（M3 段階 5）と
 * マクロ（M4）で、どちらも例外になる。
 * ゴールデンテストの側はそのケースに `!pending` の印を付けてある（ADR-0019）。
 *
 * **エラーは値として返し、例外にしない**（要件 F-8-1）。例外にすると評価の途中で制御が飛び、
 * §6.0 の伝播順序（受け手 → 引数を左から右 → 送信）を値の受け渡しで表せなくなる。
 * **例外を使うのは「まだ実装が無い」ことを言うときだけ**で、これは仕様上の状態ではない。
 */

import { isResolvable, parseAddress } from '../model/address.ts';
import { LexicalError } from '../syntax/lexer.ts';
import {
  type Expression,
  type LiteralNode,
  ParseError,
  parseFormula,
  type SendNode,
} from '../syntax/parser.ts';
import { StepBudget } from './budget.ts';
import { makeRange } from './range.ts';
import { sendMessage } from './send.ts';
import {
  type BlockValue,
  type CellValue,
  type CellValues,
  type Environment,
  heldValue,
  type ReceivedValue,
  type Value,
} from './value.ts';

const TIMEOUT: Value = { kind: 'error', error: 'Timeout' };

/** 解決できない参照（§4.2）。行 0 のセルと、どこにも束縛されていない識別子。 */
const REF: Value = { kind: 'error', error: 'Ref' };

/** 引数の型が合わない（§6.0 の検査の順序 2）。範囲の端がセルでないときに返る。 */
const TYPE_ERROR: Value = { kind: 'error', error: 'TypeError' };

/** どのセルも空のシート。**シートを渡されない評価**（`sec eval` の式）が使う。 */
const EMPTY_CELLS: CellValues = () => ({ kind: 'nil' });

/** まだ評価できないノードに当たったことを表す。**仕様上のエラーではない。** */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`未実装: ${what}の評価はまだできません。`);
    this.name = 'NotImplementedError';
  }
}

/**
 * 構文エラーの位置と説明文（要件 F-8-3）。**`#Syntax` の値には載せない。**
 *
 * 載せると「同じ `#Syntax` でも位置が違えば別の値か」を決めることになるが、§6.0 は
 * 「エラーはメッセージを受け取らない」としか定めていない。**値と組にして外へ出す**方が、
 * 比較の意味論に手を触れずに済む。受け取り手は CLI と Web UI。
 */
export interface Diagnostic {
  /** 字句の段階か構文の段階か。**利用者にはどちらも `#Syntax`** だが、報告する側には要る。 */
  readonly phase: 'lexical' | 'parse';
  /** 1 から数える行。 */
  readonly line: number;
  /** 1 から数える列。**コードポイントで数える**（字句解析器と揃える）。 */
  readonly column: number;
  /** 人間にも AI にも読める説明文（要件 F-8-3）。 */
  readonly message: string;
}

/**
 * 評価の結果。**値と診断の組**で、診断が付くのは構文エラーのときだけである。
 *
 * 実行時のエラー（`#DivideByZero` など）は位置を持たない。位置を持てるのは
 * 構文解析までの段階だけで、**評価器は原文のどこを見ているかを追っていない。**
 */
export interface Evaluation {
  readonly value: Value;
  readonly diagnostic?: Diagnostic;
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
 * @param cells セルの値を答えるもの（§4.2）。**省けばどのセルも空**として扱う
 * @returns 値と診断の組。エラーも値として返る
 * @throws {NotImplementedError} まだ評価できないノードに当たった場合
 */
export function evaluateFormula(source: string, cells: CellValues = EMPTY_CELLS): Evaluation {
  try {
    // 数式の最上位に束縛は無い。名前を導入できるのはブロックの引数だけである（§5.1）。
    // **予算は評価ごとに作り直す**ので、使い切った評価が次の評価に影響しない。
    return { value: evaluate(parseFormula(source), EMPTY_ENVIRONMENT, new StepBudget(), cells) };
  } catch (error) {
    if (error instanceof LexicalError || error instanceof ParseError) {
      return {
        value: { kind: 'error', error: 'Syntax' },
        diagnostic: {
          phase: error instanceof LexicalError ? 'lexical' : 'parse',
          line: error.line,
          column: error.column,
          message: error.message,
        },
      };
    }
    // 深い入れ子は構文解析器と評価器のどちらの再帰も尽きさせうる。**どちらで尽きても
    // 仕様外の例外を漏らさない。** 超過した評価は `#Timeout`（§7.8）。
    //
    // **これは上限そのものではなく安全網である。** ステップ数の上限は `StepBudget` が
    // 持つが（要件 N-5、CLAUDE.md 規約 4）、**再帰の深さはステップ数では表せない。**
    // 1 ステップしか使わない式でも入れ子が深ければスタックが尽きるので、両方が要る。
    if (error instanceof RangeError) {
      return { value: { kind: 'error', error: 'Timeout' } };
    }
    throw error;
  }
}

const EMPTY_ENVIRONMENT: Environment = new Map();

/**
 * リテラルを値にする。**環境も送信も要らない**ので、束縛の無い環境で評価できる。
 *
 * セルの内容の解釈（ADR-0021 の段 2）が使う。`evaluateFormula` に原文を渡し直す形でも
 * 書けるが、**同じ原文を 2 度解析することになる。** 呼び出し側は既に木を持っている。
 *
 * @param node 構文解析器がリテラルとして読んだノード
 * @returns その値。**エラーになることがある**（`1.0e400` は `#Overflow`、ADR-0013）
 */
export function evaluateLiteral(node: LiteralNode): Value {
  // リテラルにセル参照は現れない（§2）ので、どのセルも空のまま評価してよい。
  return evaluate(node, EMPTY_ENVIRONMENT, new StepBudget(), EMPTY_CELLS);
}

/**
 * リテラル配列の要素は式ではなくリテラルなので（§2.4）、同じ経路で値にできる。
 *
 * @param environment その位置で見えている束縛（§5.1）。ブロックの引数だけが入る
 * @param budget 1 回の評価が使えるステップ数（要件 N-5、§7.8）
 * @param cells セルの値を答えるもの（§4.2）
 */
function evaluate(
  node: Expression | LiteralNode,
  environment: Environment,
  budget: StepBudget,
  cells: CellValues,
): Value {
  // **1 ノードの評価が 1 ステップ。** 尽きた評価は中断して `#Timeout`（§7.8）。
  if (!budget.spend()) return TIMEOUT;

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
    // リテラル配列の要素に識別子は現れない（§2.4）が、経路を分けない方が安い。
    case 'array': {
      const elements: Value[] = [];
      for (const element of node.elements) {
        const value = evaluate(element, environment, budget, cells);
        // **予算切れは値ではなく打ち切りである**（§7.8）。要素に混ぜると、打ち切られた
        // ことが式の値から読み取れなくなる。**要素の `#Overflow`（`#(1.0e400)`）とは
        // 違う**ので、ここだけは種別を見て分ける。あちらは表せない値であって、
        // 評価が途中で止まったわけではない。
        if (value.kind === 'error' && value.error === 'Timeout') return value;
        elements.push(value);
      }
      return { kind: 'array', elements };
    }
    // 構文解析の段階で生じたエラー（倍精度に収まらない小数）。木に載っているものを
    // そのまま値にする（ADR-0013）。構文エラーではないので #Syntax ではない。
    case 'error':
      return { kind: 'error', error: node.error };
    // **ブロックは作るだけでは本体を評価しない**（§5.1）。木のまま値に載せ、
    // `value` を送られたときに `invokeBlock` が評価する。
    case 'block':
      return { kind: 'block', parameters: node.parameters, body: node, environment };
    case 'send':
      return evaluateSend(node, environment, budget, cells);
    // **セル参照は `Cell` に評価される**（§4.2、ADR-0008）。ここでは値を読まない。
    // 読むのは委譲（規則 2）か `value` の送信で、**範囲は読まないまま作れる**（§4.3）。
    case 'cell': {
      const address = parseAddress(node.name);
      // 構文解析器が通した綴りなので番地にはなる。**解決できるかは別の規則**で、
      // 行が 1 始まりでなければ（`A0` / `A000`）指す先が無い（§4.2、ADR-0020）。
      if (address === null || !isResolvable(address)) return REF;
      return { kind: 'cell', address, values: cells };
    }
    // 束縛されている識別子はブロックの引数（§5.1）。**それ以外は解決できない**——
    // 数式から参照できる名前が存在しないため（名前付き範囲は MVP の範囲外、§4.2）。
    case 'identifier':
      return environment.get(node.name) ?? REF;
  }
}

/**
 * §3.6 の評価順序をそのまま書いたもの。**受け手 → 引数を左から右 → 送信。**
 *
 * **最初に生じたエラーがその式全体の値になり、それ以降は評価しない**（§6.0、ADR-0011）。
 * エラーの種別に強弱は無く、決めるのは順序だけである。打ち切りをここに集めてあるので、
 * **エラーが受け手や引数として送信まで届くことはない**（`ReceivedValue` がそれを表す）。
 */
function evaluateSend(
  node: SendNode,
  environment: Environment,
  budget: StepBudget,
  cells: CellValues,
): Value {
  const receiver = evaluate(node.receiver, environment, budget, cells);
  if (receiver.kind === 'error') return receiver;

  const args: ReceivedValue[] = [];
  for (const argument of node.arguments) {
    const value = evaluate(argument, environment, budget, cells);
    if (value.kind === 'error') return value;
    args.push(value);
  }

  // **規則 1（§4.2）。** 受け手がセルで、そのセレクタを `Cell` 自身が理解するなら、
  // 受け手も引数もそのまま送る。これが無いと `to:` の引数まで値に置き換わり、
  // 範囲が作れなくなる。
  if (receiver.kind === 'cell') {
    const own = sendToCell(receiver, node.selector, args);
    if (own !== null) return own;
  }

  // **規則 2（§4.2）。** それ以外は、受け手と引数のうちセルであるものを保持する値に
  // 置き換えてから送る。**委譲は受け手の側でしか起きない**ので、引数の側も解決しないと
  // `A1 + B1` が `3 + <Cell>` になり、値どうしの演算にならない。
  //
  // **解決した値がエラーなら、そこで打ち切る**（§6.0）。順序は受け手 → 引数の左から右で、
  // 評価の順序（§3.6）と同じである。
  const resolved = heldValue(receiver);
  if (resolved.kind === 'error') return resolved;

  const resolvedArgs: ReceivedValue[] = [];
  for (const argument of args) {
    const value = heldValue(argument);
    if (value.kind === 'error') return value;
    resolvedArgs.push(value);
  }

  // 予算を `InvokeBlock` の形に閉じ込める。送信の側は引数の数だけを知っていればよい。
  return sendMessage(
    resolved,
    node.selector,
    resolvedArgs,
    (block, blockArgs) => invokeBlock(block, blockArgs, budget, cells),
    budget,
  );
}

/**
 * `Cell` 自身が理解するセレクタ（§4.2 の規則 1）。
 *
 * **`send.ts` ではなくここに置いた。** 規則 1 と規則 2 の分かれ目そのものなので、
 * 「`Cell` が何を理解するか」が 2 箇所に散ると**片方だけ足したときに委譲の向きが狂う。**
 *
 * @returns 送信の結果。**理解しないセレクタは `null`** で、呼び出し側が規則 2 へ回す
 */
function sendToCell(
  cell: CellValue,
  selector: string,
  args: readonly ReceivedValue[],
): Value | null {
  const [first] = args;

  if (first === undefined) {
    return selector === 'value' ? cell.values(cell.address) : null;
  }

  // **範囲はセルの対からしか作れない**（§4.3）。引数の型の誤りなので `#TypeError`
  // であって、`#DoesNotUnderstand` ではない（§6.0 の検査の順序）。
  // **受け手がセルである以上、`to:` は理解している。**
  if (selector === 'to:' && args.length === 1) {
    return first.kind === 'cell' ? makeRange(cell.address, first.address) : TYPE_ERROR;
  }

  return null;
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
 * @param budget 1 回の評価が使えるステップ数（要件 N-5、§7.8）
 * @param cells セルの値を答えるもの（§4.2）。本体の中のセル参照が使う
 */
function invokeBlock(
  block: BlockValue,
  args: readonly ReceivedValue[],
  budget: StepBudget,
  cells: CellValues,
): Value {
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

  return evaluate(statement, environment, budget, cells);
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
