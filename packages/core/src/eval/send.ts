/**
 * メッセージの振り分け（仕様書 §6.0）。受け手と引数が値になった後の 1 回の送信を担う。
 *
 * **1 回の送信の中の検査は次の順で行う。**
 *
 * 1. 受け手がセレクタを持つか → `#DoesNotUnderstand`
 * 2. 引数の型が合うか → `#TypeError`
 * 3. 演算が定義されるか → `#DivideByZero`
 * 4. 結果を表せるか → `#Overflow`
 *
 * **`#DoesNotUnderstand` は受け手、`#TypeError` は引数の話である。** 混同すると
 * `nil + 1`（前者）と `1 + nil`（後者）が区別できなくなる。
 * これは**受け手と引数のどちらを先に評価するか**（§3.6 の伝播順序）とは別のもので、
 * そちらは `evaluate.ts` が引き受ける。
 *
 * **セレクタは段階ごとに足す。** 現時点で持たせてあるのは、対象にしているゴールデンテスト
 * （`messages` / `precedence` / `errors` / `literals`）が送るものだけである。
 * **持たせていないセレクタは `#DoesNotUnderstand` になる。** これは仕様上ありうる値なので、
 * 未実装であることの印にはならない。取り違えを防ぐのは、緑にしたファイルを
 * `evaluate.test.mjs` の対象へ足していく運用の側（ADR-0019）。
 */

import {
  absoluteValue,
  add,
  compareNumbers,
  divide,
  isNumber,
  multiply,
  negate,
  subtract,
} from './number.ts';
import type {
  BlockValue,
  BooleanValue,
  ErrorValue,
  NumberValue,
  ReceivedValue,
  Value,
} from './value.ts';

/**
 * ブロックの本体を評価して値にする。**評価器の側にしかできない**ので受け取る。
 * 条件式が選ばれた側だけを評価できるのは、引数がブロックの**値**で渡るからである（§5.2）。
 */
export type InvokeBlock = (block: BlockValue) => Value;

const TYPE_ERROR: ErrorValue = { kind: 'error', error: 'TypeError' };
const DOES_NOT_UNDERSTAND: ErrorValue = { kind: 'error', error: 'DoesNotUnderstand' };

const boolean = (value: boolean): Value => ({ kind: 'boolean', value });

/** 引数が数でなければ `#TypeError`（検査の順序 2）。 */
const withNumber = (argument: ReceivedValue, operation: (argument: NumberValue) => Value): Value =>
  isNumber(argument) ? operation(argument) : TYPE_ERROR;

/**
 * 数のセレクタ（§6.1）。
 *
 * **引数の数でまず分ける。** セレクタの綴りが引数の数を決めるので（§3）、数の合わない
 * セレクタはそもそも別のセレクタであり、受け手が理解しないものとして扱ってよい。
 * 分割代入で受けているのは `noUncheckedIndexedAccess` の下で添字の `undefined` を潰すため。
 */
function sendToNumber(
  receiver: NumberValue,
  selector: string,
  args: readonly ReceivedValue[],
): Value | undefined {
  const [first, second] = args;

  if (first === undefined) {
    switch (selector) {
      case 'abs':
        return absoluteValue(receiver);
      case 'negated':
        return negate(receiver);
      case 'squared':
        return multiply(receiver, receiver);
      default:
        return undefined;
    }
  }

  if (second === undefined) {
    switch (selector) {
      // = は型が違ってもエラーにならない。等しくないだけである（§6.1）。
      case '=':
        return boolean(isNumber(first) && compareNumbers(receiver, first) === 0);
      case '+':
        return withNumber(first, (argument) => add(receiver, argument));
      case '-':
        return withNumber(first, (argument) => subtract(receiver, argument));
      case '*':
        return withNumber(first, (argument) => multiply(receiver, argument));
      case '/':
        return withNumber(first, (argument) => divide(receiver, argument));
      case '>':
        return withNumber(first, (argument) => boolean(compareNumbers(receiver, argument) === 1));
      case '>=':
        return withNumber(first, (argument) => boolean(compareNumbers(receiver, argument) >= 0));
      // min: と max: は < と > で定義する（§6.1）。**等しければ比較が偽になるので
      // 引数を返す。** 整数と小数は値で比べるため、等しくても型が違うことがある。
      case 'max:':
        return withNumber(first, (argument) =>
          compareNumbers(receiver, argument) === 1 ? receiver : argument,
        );
      case 'min:':
        return withNumber(first, (argument) =>
          compareNumbers(receiver, argument) === -1 ? receiver : argument,
        );
      default:
        return undefined;
    }
  }

  if (selector !== 'between:and:') return undefined;
  // 境界は含む。**逆向きの区間は正規化しない**ので常に false になる（§6.1）。
  // 範囲（§4.3）が逆向きを正規化するのとは異なる。
  return withNumber(first, (lower) =>
    withNumber(second, (upper) =>
      boolean(compareNumbers(receiver, lower) >= 0 && compareNumbers(receiver, upper) <= 0),
    ),
  );
}

/**
 * 真偽値のセレクタ（§5.2）。**引数はブロックでなければならない。**
 * 値を直接渡せてしまうと先行評価になり、遅延評価の要件（F-2-9）を満たさない。
 */
function sendToBoolean(
  receiver: BooleanValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  const [whenTrue, whenFalse] = args;
  if (selector !== 'ifTrue:ifFalse:' || whenTrue === undefined || whenFalse === undefined) {
    return undefined;
  }
  if (whenTrue.kind !== 'block' || whenFalse.kind !== 'block') return TYPE_ERROR;

  // 選ばれなかった側は評価しない。中にエラーがあっても生じない（§5.2）。
  return invoke(receiver.value ? whenTrue : whenFalse);
}

/** ブロックのセレクタ（§5.1）。**引数の数が合わなければ `#TypeError`。** */
function sendToBlock(
  receiver: BlockValue,
  selector: string,
  invoke: InvokeBlock,
): Value | undefined {
  // `value:` / `value:value:` は段階 5 で入れる。引数を名前に束ねる環境が要るためで、
  // それが無いうちは**引数を取るブロックは数が合わない**として扱う。
  if (selector !== 'value') return undefined;
  if (receiver.parameters.length > 0) return TYPE_ERROR;
  return invoke(receiver);
}

function dispatch(
  receiver: ReceivedValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  switch (receiver.kind) {
    case 'integer':
    case 'decimal':
      return sendToNumber(receiver, selector, args);
    case 'boolean':
      return sendToBoolean(receiver, selector, args, invoke);
    case 'block':
      return sendToBlock(receiver, selector, invoke);
    // §6.2 と §6.3 のセレクタはまだ持たせていない。
    case 'string':
    case 'symbol':
    case 'nil':
    case 'array':
      return undefined;
  }
}

/**
 * 受け手にメッセージを送る。**受け手も引数も評価済みの値である**（§3.6 の先行評価）。
 *
 * @param receiver 受け手。エラーはここへ来ない（§6.0。型がそれを表している）
 * @param selector 連結済みのセレクタ（`between:and:`）
 * @param args 引数。セレクタの綴りが決める数だけ並ぶ
 * @param invoke ブロックの本体を評価する関数
 * @returns 送信の結果。エラーも値として返る
 */
export function sendMessage(
  receiver: ReceivedValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value {
  // 検査の順序 1（§6.0）: 受け手がそのセレクタを持たない。
  return dispatch(receiver, selector, args, invoke) ?? DOES_NOT_UNDERSTAND;
}
