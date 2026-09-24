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
 * **マクロは本体とブロックの文の列と一時変数、ブロックの中の `^`、セルへの代入まで
 * 評価でき、1 回の実行が 1 つのトランザクションになる**（§7.2〜§7.5・§7.8、M4 段階 1〜5）。
 *
 * **エラーは値として返し、例外にしない**（要件 F-8-1）。例外にすると評価の途中で制御が飛び、
 * §6.0 の伝播順序（受け手 → 引数を左から右 → 送信）を値の受け渡しで表せなくなる。
 * **例外を使うのは 2 つだけ。** 「まだ実装が無い」ことを言うとき（仕様上の状態ではない）と、
 * 非局所リターン（`MacroReturn`）である。
 */

import { type CellAddress, isResolvable, parseAddress } from '../model/address.ts';
import { LexicalError } from '../syntax/lexer.ts';
import {
  type Body,
  type Expression,
  type LiteralNode,
  ParseError,
  parseFormula,
  parseMacroBody,
  type SendNode,
} from '../syntax/parser.ts';
import { StepBudget } from './budget.ts';
import { makeRange } from './range.ts';
import { sendMessage } from './send.ts';
import {
  type Binding,
  type BlockValue,
  type CellValue,
  type CellValues,
  type Environment,
  type ErrorValue,
  heldValue,
  type NilValue,
  printValue,
  type ReceivedValue,
  type Value,
} from './value.ts';
import { contentToWrite } from './write.ts';

const TIMEOUT: Value = { kind: 'error', error: 'Timeout' };

const NIL: NilValue = { kind: 'nil' };

/** 解決できない参照（§4.2）。行 0 のセルと、どこにも束縛されていない識別子。 */
const REF: Value = { kind: 'error', error: 'Ref' };

/** 引数の型が合わない（§6.0 の検査の順序 2）。範囲の端がセルでないときに返る。 */
const TYPE_ERROR: Value = { kind: 'error', error: 'TypeError' };

/** どのセルも空のシート。**シートを渡されない評価**（`sec eval` の式）が使う。 */
const EMPTY_CELLS: CellValues = () => ({ kind: 'nil' });

/**
 * マクロが読み書きするシート（§4.2、§7.4）。`LiveSheet` がこの形を満たす。
 *
 * **書き込みと読みを 1 つにまとめて渡す。** 別々に渡すと、書き込んだのに読みの側が
 * 古いままのシートを組み合わせられてしまう（`LiveSheet` が対にしている理由と同じ）。
 * `LiveSheet` を直に受け取らないのは、`model` がこのファイルに依存しているためである。
 */
export interface MacroSheet {
  /** 番地からそのセルが保持する値を答える。**書き込みの後に呼べば書き込みを反映する。** */
  readonly values: CellValues;
  /** セルに内容を置く。**空の内容はセルを空にする**（ADR-0010）。 */
  put(address: CellAddress, content: string): unknown;
}

/**
 * 1 回のマクロ実行の書き込みをまとめる単位（要件 F-3-4、ADR-0027）。
 *
 * **閉じるのは `commit` か `rollback` のどちらか 1 回だけ**で、どちらにするかは
 * `evaluateMacro` が決める。読みと書きは `MacroSheet` と同じで、書き込みは閉じるまで
 * 確定しない。
 */
export interface MacroTransaction extends MacroSheet {
  /** 書き込みを確定する。 */
  commit(): unknown;
  /** 書き込んだセルを開始前の内容に戻す。**値も開始前と同じになる。** */
  rollback(): unknown;
}

/** マクロを実行できるシート。`LiveSheet` がこの形を満たす。 */
export interface TransactionalSheet {
  /** トランザクションを開く。**マクロ 1 回の実行に 1 つ。** */
  begin(): MacroTransaction;
}

/**
 * 読むだけのシート。**数式は書き込めない**（要件 F-2-10）ので、数式の評価はこれを使う。
 *
 * 数式に代入が現れないことは `parseFormula` が保証するので、`put` へは来ない。
 * 来たら実装の誤りなので、黙って捨てずに例外にする。
 */
function readOnly(values: CellValues): MacroSheet {
  return {
    values,
    put: () => {
      throw new Error('数式の評価からセルに書き込もうとしました。');
    },
  };
}

/**
 * ブロックの中の `^`（§7.5）。**マクロ全体を終える**ので、`evaluateMacro` まで制御を飛ばす。
 *
 * **値の受け渡しでは表せないので例外にした。** エラーと同じく打ち切りの印を値に載せる形も
 * あるが、ブロックを評価する経路（条件式・列挙・整列の比較・`whileTrue:`）の
 * すべてがその印を見分けて素通しする必要があり、**1 つ見落とすと `^` の値が
 * ただの値として外側の文に続いてしまう。** 例外なら経路の側は何も知らずに済む。
 *
 * **捕まえるのは `evaluateMacro` だけである。** マクロの外へ出たブロックを後から
 * 起動する経路は無い（ブロックはセルに書き込めない、ADR-0027）ので、戻り先は常に
 * いま走っているマクロである。数式のブロックには `^` を書けない（§7.7）。
 * `Error` を継承しないのは、誤りではなく制御の移動であり、スタックの記録も要らないため。
 */
class MacroReturn {
  // 引数プロパティの略記は使えない。`node` の型の除去が消せる構文ではないため（CLAUDE.md）。
  readonly value: Value;

  constructor(value: Value) {
    this.value = value;
  }
}

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
  const parsed = parseFormulaOrFail(source);
  return parsed.kind === 'failed' ? parsed.evaluation : evaluateParsedFormula(parsed.tree, cells);
}

/** 構文解析の結果。**読めなければ評価結果（`#Syntax`）になる**ので、例外は出さない。 */
type Parsed<Tree> =
  | { readonly kind: 'parsed'; readonly tree: Tree }
  | { readonly kind: 'failed'; readonly evaluation: Evaluation };

export type ParsedFormula = Parsed<Expression>;

/**
 * 数式の原文を木にする。**構文解析と評価を分けて呼べるようにしたもの。**
 *
 * **再計算が同じ木を 2 度使う**（要件 F-4-1 の依存の抽出と、F-4-2 の評価）。
 * 原文から評価し直すと、シートのすべての数式を 2 度解析することになる。
 *
 * @param source 数式の原文（セルの `=` は含めない）
 * @returns 木、または読めなかったことを表す評価結果
 */
export function parseFormulaOrFail(source: string): ParsedFormula {
  return parseOrFail(parseFormula, source);
}

/**
 * 開始記号（§7.1）を選んで木にする。**読めなかったときの扱いは開始記号で変えない。**
 * 数式でもマクロでも、利用者から見れば同じ `#Syntax` である。
 */
function parseOrFail<Tree>(parse: (source: string) => Tree, source: string): Parsed<Tree> {
  try {
    return { kind: 'parsed', tree: parse(source) };
  } catch (error) {
    if (error instanceof LexicalError || error instanceof ParseError) {
      return {
        kind: 'failed',
        evaluation: {
          value: { kind: 'error', error: 'Syntax' },
          diagnostic: {
            phase: error instanceof LexicalError ? 'lexical' : 'parse',
            line: error.line,
            column: error.column,
            message: error.message,
          },
        },
      };
    }
    // 深い入れ子は構文解析器の再帰を尽きさせうる。**仕様外の例外を漏らさない。**
    if (error instanceof RangeError) return { kind: 'failed', evaluation: { value: TIMEOUT } };
    throw error;
  }
}

/**
 * 解析済みの数式を評価する。
 *
 * @param tree 数式の木
 * @param cells セルの値を答えるもの（§4.2）。**省けばどのセルも空**として扱う
 * @returns 値。エラーも値として返る
 * @throws {NotImplementedError} まだ評価できないノードに当たった場合
 */
export function evaluateParsedFormula(
  tree: Expression,
  cells: CellValues = EMPTY_CELLS,
): Evaluation {
  // 数式の最上位に束縛は無い。名前を導入できるのはブロックの引数だけである（§5.1）。
  // **予算は評価ごとに作り直す**ので、使い切った評価が次の評価に影響しない。
  const sheet = readOnly(cells);
  return { value: withinStack(() => evaluate(tree, EMPTY_ENVIRONMENT, new StepBudget(), sheet)) };
}

/**
 * マクロ本体の原文を評価する（開始記号 `macro body`、§7.1）。名前を付けずにその場で実行する形。
 *
 * **字句エラーと構文エラーは `evaluateFormula` と同じく `#Syntax` の値と診断の組になる。**
 *
 * @param source マクロ本体の原文（一時変数の宣言と文の列）
 * **1 回の実行が 1 つのトランザクションである**（要件 F-3-4）。値がエラーなら書き込みを
 * 巻き戻し、そうでなければ確定する。
 *
 * @param sheet 読み書きするシート（§4.2、§7.4）。**セルへの代入はここへ書き込む**
 * @returns 値と診断の組。`^` があればその値、無ければ `nil`。エラーも値として返る。
 *   **セルは返さない**——終了時点のそのセルの値を返す（ADR-0031）
 * @throws {NotImplementedError} まだ評価できないノードに当たった場合
 */
export function evaluateMacro(source: string, sheet: TransactionalSheet): Evaluation {
  const parsed = parseOrFail(parseMacroBody, source);
  // 読めなかったマクロは何も実行しないので、トランザクションを開かない。
  if (parsed.kind === 'failed') return parsed.evaluation;
  const body = parsed.tree;

  const transaction = sheet.begin();
  let value: Value;
  try {
    // **予算はマクロ 1 回の実行に 1 つ**（要件 N-5）。文ごとに作り直すと、上限に届かない文を
    // 並べるだけでいくらでも長く走れてしまう。
    // **セルは閉じる前に値まで解決する**（ADR-0031）。巻き戻した後に読めば開始前の値になり、
    // マクロが終わった時点の値ではなくなる。解決した値がエラーなら失敗として巻き戻す。
    value = heldValue(withinStack(() => runMacroBody(body, new StepBudget(), transaction)));
  } catch (error) {
    // 評価器の外の失敗（実装の誤り）でも、書きかけのシートを残さない。
    rollbackAndRethrow(transaction, error);
  }

  // **エラーで終わったマクロの書き込みは残らない**（要件 F-3-4、ADR-0027）。
  if (value.kind === 'error') {
    try {
      transaction.rollback();
    } catch (rollbackError) {
      // 元の失敗は値なので、その表記を持つ例外にして同じく両方を投げる（`rollbackAndRethrow`）。
      const failure = new Error(`マクロが ${printValue(value)} で終わりました。`, { cause: value });
      throw new AggregateError([failure, rollbackError], ROLLBACK_FAILED);
    }
    return { value };
  }
  try {
    transaction.commit();
  } catch (error) {
    // 確定で初めて計算する下流の数式が抜けても、書きかけのシートを残さない。
    rollbackAndRethrow(transaction, error);
  }
  return { value };
}

const ROLLBACK_FAILED = 'マクロの失敗の後、巻き戻しにも失敗しました。';

/**
 * 巻き戻してから、元の失敗を投げ直す。
 *
 * **巻き戻しも失敗したら、両方を投げる。** 巻き戻しの失敗だけを投げると元の失敗が
 * 呼び出し元に届かず、元の失敗だけを投げると巻き戻せなかったことが隠れる。
 */
function rollbackAndRethrow(transaction: MacroTransaction, error: unknown): never {
  try {
    transaction.rollback();
  } catch (rollbackError) {
    throw new AggregateError([error, rollbackError], ROLLBACK_FAILED);
  }
  throw error;
}

/**
 * マクロ本体の文の列を評価し、マクロの値にする。**ブロックの中の `^` はここで受け止める**（§7.5）。
 */
function runMacroBody(body: Body, budget: StepBudget, sheet: MacroSheet): Value {
  try {
    const value = runStatements(body, declareTemporaries(EMPTY_ENVIRONMENT, body), budget, sheet);
    // `^` が無ければ `nil`（§7.2）。マクロは値を返すために書くとは限らない。
    // `^` は列の最後にしか書けない（構文解析器が弾く）ので、最後の文だけを見ればよい。
    if (value.kind === 'error' || body.statements.at(-1)?.kind === 'return') return value;
    return NIL;
  } catch (signal) {
    if (signal instanceof MacroReturn) return signal.value;
    throw signal;
  }
}

/**
 * 深い入れ子は評価器の再帰も尽きさせうる。超過した評価は `#Timeout`（§7.8）。
 *
 * **これは上限そのものではなく安全網である。** ステップ数の上限は `StepBudget` が
 * 持つが（要件 N-5、CLAUDE.md 規約 4）、**再帰の深さはステップ数では表せない。**
 * 1 ステップしか使わない式でも入れ子が深ければスタックが尽きるので、両方が要る。
 * 明示的な再帰深度の上限は M4 の段階 7 で入れる（ADR-0027）。
 */
function withinStack(run: () => Value): Value {
  try {
    return run();
  } catch (error) {
    if (error instanceof RangeError) return TIMEOUT;
    throw error;
  }
}

/**
 * 一時変数を宣言した環境を作る（§7.2、§7.5）。宣言しただけの一時変数は `nil`。
 *
 * **呼ぶたびに新しい入れ物を作る。** ブロックの一時変数は起動ごとに別のもので
 * （ADR-0029）、再帰の各段が同じ入れ物を使うと内側の起動が外側の値を書き換える。
 * **外側の束縛は写すだけ**なので、入れ物は外側と共有される（`Binding`）。
 */
function declareTemporaries(outer: Environment, body: Body): Map<string, Binding> {
  const environment = new Map(outer);
  for (const name of body.temporaries) environment.set(name, { value: NIL });
  return environment;
}

/**
 * 文の列を順に評価し、**最後の文の値**を返す（§7.2、§7.5）。代入は値を持たないので `nil`。
 * `^` の文はその式の値で、`^` として扱うのは呼ぶ側である（マクロの本体とブロックで違う）。
 *
 * **文の値がエラーなら、そこで打ち切ってそのエラーを列の値にする**（ADR-0027 の案 A）。
 * 値を捨てる文でも、一時変数への代入の右辺でも同じで、**エラーを黙って捨てる経路を作らない。**
 * §3.6 の「最初に生じたエラーを返す」を文の列に当てたものである。
 */
function runStatements(
  body: Body,
  environment: Environment,
  budget: StepBudget,
  sheet: MacroSheet,
): Value {
  let last: Value = NIL;
  for (const statement of body.statements) {
    switch (statement.kind) {
      case 'return':
        last = evaluate(statement.value, environment, budget, sheet);
        break;
      case 'assign': {
        const value = evaluate(statement.value, environment, budget, sheet);
        // 右辺がエラーなら代入しない。エラーを変数に抱えて先へ進めない（ADR-0027）。
        if (value.kind === 'error') return value;
        if (statement.target.kind === 'cell') {
          const failure = assignCell(statement.target.name, value, sheet);
          if (failure !== null) return failure;
          last = NIL;
          break;
        }
        const binding = environment.get(statement.target.name);
        // 左辺は宣言済みの一時変数に限る（構文解析器が弾く、§7.3）ので、ここへは来ない。
        // 来たとしても、宣言の無い名前を読んだときと同じ `#Ref` にしておく（§4.2）。
        if (binding === undefined) return REF;
        binding.value = value;
        last = NIL;
        break;
      }
      default:
        last = evaluate(statement, environment, budget, sheet);
    }
    if (last.kind === 'error') return last;
  }
  return last;
}

/**
 * セルへの代入（§7.4）。**左辺のセルは読まない**——書き込み先を指すだけなので、
 * 元の値がエラーでも通る。右辺は呼ぶ側が評価済みで、エラーでないことも確かめてある。
 *
 * @param name 左辺のセル参照の綴り
 * @returns 書き込めなければそのエラー。**書き込めなかったセルは書き換わらない**
 */
function assignCell(name: string, value: Value, sheet: MacroSheet): ErrorValue | null {
  const address = parseAddress(name);
  // 行が 1 始まりでなければ指す先が無い（§4.2、ADR-0020）。読むときと同じ `#Ref`。
  if (address === null || !isResolvable(address)) return { kind: 'error', error: 'Ref' };
  const content = contentToWrite(value);
  if (typeof content !== 'string') return content;
  sheet.put(address, content);
  return null;
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
  return evaluate(node, EMPTY_ENVIRONMENT, new StepBudget(), readOnly(EMPTY_CELLS));
}

/**
 * リテラル配列の要素は式ではなくリテラルなので（§2.4）、同じ経路で値にできる。
 *
 * @param environment その位置で見えている束縛。ブロックの引数（§5.1）とマクロの一時変数（§7.2）
 * @param budget 1 回の評価が使えるステップ数（要件 N-5、§7.8）
 * @param sheet 読み書きするシート（§4.2、§7.4）。数式では書き込めない
 */
function evaluate(
  node: Expression | LiteralNode,
  environment: Environment,
  budget: StepBudget,
  sheet: MacroSheet,
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
        const value = evaluate(element, environment, budget, sheet);
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
      return evaluateSend(node, environment, budget, sheet);
    // **セル参照は `Cell` に評価される**（§4.2、ADR-0008）。ここでは値を読まない。
    // 読むのは委譲（規則 2）か `value` の送信で、**範囲は読まないまま作れる**（§4.3）。
    case 'cell': {
      const address = parseAddress(node.name);
      // 構文解析器が通した綴りなので番地にはなる。**解決できるかは別の規則**で、
      // 行が 1 始まりでなければ（`A0` / `A000`）指す先が無い（§4.2、ADR-0020）。
      if (address === null || !isResolvable(address)) return REF;
      return { kind: 'cell', address, values: sheet.values };
    }
    // 束縛されている識別子はブロックの引数（§5.1）か一時変数（§7.2）。**それ以外は解決できない**——
    // 数式から参照できる名前が存在しないため（名前付き範囲は MVP の範囲外、§4.2）。
    case 'identifier':
      return environment.get(node.name)?.value ?? REF;
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
  sheet: MacroSheet,
): Value {
  const receiver = evaluate(node.receiver, environment, budget, sheet);
  if (receiver.kind === 'error') return receiver;

  // **規則 1（§4.2）。** 受け手がセルで、そのセレクタを `Cell` 自身が理解するなら、
  // 受け手も引数もそのまま送る。これが無いと `to:` の引数まで値に置き換わり、
  // 範囲が作れなくなる。**どちらの規則になるかはセレクタと引数の数だけで決まる**ので、
  // 引数を評価する前に分かる。
  const own = receiver.kind === 'cell' && isCellOwnSelector(node.selector, node.arguments.length);

  // **規則 2 の受け手の解決は、引数を評価するより前に行う**（§6.0 の伝播順序）。
  // 受け手のセルが先に評価されるとは、**そのセルの値がエラーなら引数に到達しない**
  // ということである（`A1 + (1 / 0)` は A1 が循環していれば `#Circular`）。
  // 規則 1 のときに解決しないのは、範囲がセルの値を読まないため（§4.3）。
  let resolvedReceiver: ReceivedValue | null = null;
  if (!own) {
    const resolved = heldValue(receiver);
    if (resolved.kind === 'error') return resolved;
    resolvedReceiver = resolved;
  }

  const args: ReceivedValue[] = [];
  for (const argument of node.arguments) {
    const value = evaluate(argument, environment, budget, sheet);
    if (value.kind === 'error') return value;
    args.push(value);
  }

  if (own && receiver.kind === 'cell') return sendToCell(receiver, node.selector, args);

  // **規則 2（§4.2）。** 受け手と引数のうちセルであるものを保持する値に置き換えてから送る。
  // **委譲は受け手の側でしか起きない**ので、引数の側も解決しないと
  // `A1 + B1` が `3 + <Cell>` になり、値どうしの演算にならない。
  //
  // **解決した値がエラーなら、そこで打ち切る**（§6.0）。順序は受け手 → 引数の左から右で、
  // 評価の順序（§3.6）と同じである。
  const resolvedArgs: ReceivedValue[] = [];
  for (const argument of args) {
    const value = heldValue(argument);
    if (value.kind === 'error') return value;
    resolvedArgs.push(value);
  }

  // 受け手は上で解決してある。規則 1 でないなら必ず値が入っている。
  const resolved = resolvedReceiver ?? heldValue(receiver);
  if (resolved.kind === 'error') return resolved;

  // 予算を `InvokeBlock` の形に閉じ込める。送信の側は引数の数だけを知っていればよい。
  return sendMessage(
    resolved,
    node.selector,
    resolvedArgs,
    (block, blockArgs) => invokeBlock(block, blockArgs, budget, sheet),
    budget,
  );
}

/**
 * `Cell` 自身が理解するセレクタか（§4.2 の規則 1）。**綴りと引数の数だけで決まる。**
 *
 * **引数の値を見ない。** 規則 1 と規則 2 の分かれ目は受け手の解決より前に要る
 * （解決すると `to:` の引数が値に置き換わって範囲が作れない）ためで、
 * `to:` の引数がセルでなければ `#TypeError` になる——それは送信の中の検査である。
 */
function isCellOwnSelector(selector: string, arity: number): boolean {
  return (selector === 'value' && arity === 0) || (selector === 'to:' && arity === 1);
}

/**
 * `Cell` 自身が理解するセレクタを送る（§4.2 の規則 1）。
 *
 * **`send.ts` ではなくここに置いた。** 規則 1 と規則 2 の分かれ目そのものなので、
 * 「`Cell` が何を理解するか」が 2 箇所に散ると**片方だけ足したときに委譲の向きが狂う。**
 *
 * @param args 引数。**`isCellOwnSelector` を満たす数であること**を呼ぶ側が確かめてある
 */
function sendToCell(cell: CellValue, selector: string, args: readonly ReceivedValue[]): Value {
  if (selector === 'value') return cell.values(cell.address);

  // 規則 1 に入るセレクタは `value` と `to:` だけなので（`isCellOwnSelector`）、
  // ここから先は `to:` である。引数が 1 つあることも呼ぶ側が確かめてある。
  const [first] = args;
  if (first === undefined) return TYPE_ERROR;

  // **範囲はセルの対からしか作れない**（§4.3）。引数の型の誤りなので `#TypeError`
  // であって、`#DoesNotUnderstand` ではない（§6.0 の検査の順序）。
  // **受け手がセルである以上、`to:` は理解している。**
  //
  // **値を引く手段は受け手から渡す。** 範囲の列挙が渡す要素は `Cell` なので（§6.3）、
  // 矩形の中のどの番地についても同じものが要る。
  return first.kind === 'cell' ? makeRange(cell.address, first.address, cell.values) : TYPE_ERROR;
}

/**
 * ブロックの本体を評価する。**値は最後の文の値**で（§7.5）、数式のブロックは
 * 文が式ちょうど 1 つの場合にあたる（§5.1）。数式に文の列と一時変数が現れないことは
 * `parseFormula` が保証するので、**ここで開始記号を区別しない。**
 *
 * **引数の数の検査をここに置いた**（§5.1）。`value:` の送信だけでなく、条件式が
 * ブロックを引数なしで評価する経路（§5.2）にも同じ規則が当たる必要があるためで、
 * 呼び出しの側それぞれに書くと**足し忘れた 1 つが検査を抜ける。**
 *
 * @param args 引数に束ねる値。セレクタの綴りが数を決める（`value:value:` なら 2 つ）
 * @param budget 1 回の評価が使えるステップ数（要件 N-5、§7.8）
 * @param sheet 読み書きするシート（§4.2、§7.4）。本体の中のセル参照と代入が使う
 */
function invokeBlock(
  block: BlockValue,
  args: readonly ReceivedValue[],
  budget: StepBudget,
  sheet: MacroSheet,
): Value {
  const environment = bindParameters(block, args);
  if (environment === null) return { kind: 'error', error: 'TypeError' };

  const value = runStatements(block.body, environment, budget, sheet);
  // **ブロックの中の `^` はマクロ全体を終える**（§7.5）。ブロックの値として返すと
  // 外側の文が続いてしまう。値がエラーなら `^` に達したかどうかを問わずそのまま返す——
  // エラーはどの経路でも打ち切りとして外へ伝わり、マクロはそのエラーで終わる（ADR-0027）。
  if (value.kind !== 'error' && block.body.statements.at(-1)?.kind === 'return') {
    throw new MacroReturn(value);
  }
  return value;
}

/**
 * ブロックが捕まえた環境に引数と一時変数を重ねる。**名前が衝突することはない**（外側と
 * 同じ名前は宣言できず、構文解析器が既に弾いている）ので、上書きの向きを考えずに済む。
 *
 * @returns 本体を評価する環境。**引数の数が合わなければ `null`**（§5.1 の `#TypeError`）
 */
function bindParameters(block: BlockValue, args: readonly ReceivedValue[]): Environment | null {
  if (block.parameters.length !== args.length) return null;
  // 数式のブロックの大半はここを通る。写さずに済むなら写さない。
  if (args.length === 0 && block.body.temporaries.length === 0) return block.environment;

  const bindings = declareTemporaries(block.environment, block.body);
  for (const [index, value] of args.entries()) {
    const name = block.parameters[index];
    // 数が合うことは上で確かめてあるので、ここへは来ない。
    if (name === undefined) return null;
    bindings.set(name, { value });
  }
  return bindings;
}
