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
 * **セレクタは段階ごとに足す。** 現時点で持たせてあるのは §6.1 の `Number` 全体、
 * §6.2 の `String` / `Boolean` / `Symbol` / `nil` 全体と、`Block` の `value` である。
 * **`Cell` 自身が理解するセレクタは `evaluate.ts` が持つ**（§4.2 の委譲の分かれ目そのもので、
 * ここに置くと規則 1 と規則 2 の判定が 2 箇所に散る）。
 * **持たせていないセレクタは `#DoesNotUnderstand` になる。** これは仕様上ありうる値なので、
 * 未実装であることの印にはならない。取り違えを防ぐのは、緑にしたファイルを
 * `evaluate.test.mjs` の対象へ足していく運用の側（ADR-0019）。
 */

import type { StepBudget } from './budget.ts';
import {
  absoluteValue,
  add,
  compareNumbers,
  divide,
  floorDivide,
  isNumber,
  modulo,
  multiply,
  negate,
  round,
  squareRoot,
  subtract,
  truncate,
} from './number.ts';
import { isSameRectangle } from './range.ts';
import {
  at,
  averageOf,
  collectWith,
  countOf,
  detectWith,
  filterWith,
  firstOf,
  injectWith,
  isSequenceEqual,
  lastOf,
  makeInterval,
  maxOf,
  minOf,
  type SequenceValue,
  sequenceSize,
  sortWith,
  sumOf,
} from './sequence.ts';
import {
  characterCount,
  copyFrom,
  indexOfSubstring,
  lowerCase,
  parseNumber,
  upperCase,
} from './string.ts';
import {
  type BlockValue,
  type BooleanValue,
  type ErrorValue,
  heldValue,
  type NumberValue,
  type ReceivedValue,
  type StringValue,
  type Value,
} from './value.ts';

/**
 * ブロックの本体を評価して値にする。**評価器の側にしかできない**ので受け取る。
 * 条件式が選ばれた側だけを評価できるのは、引数がブロックの**値**で渡るからである（§5.2）。
 *
 * **引数の数の検査も向こう側にある**（§5.1）。条件式はブロックを引数なしで評価するので、
 * `true ifTrue: [:x | x]` も `#TypeError` になる。
 */
export type InvokeBlock = (block: BlockValue, args: readonly ReceivedValue[]) => Value;

const TYPE_ERROR: ErrorValue = { kind: 'error', error: 'TypeError' };
const DOES_NOT_UNDERSTAND: ErrorValue = { kind: 'error', error: 'DoesNotUnderstand' };

const NIL: Value = { kind: 'nil' };

const boolean = (value: boolean): Value => ({ kind: 'boolean', value });
const string = (value: string): Value => ({ kind: 'string', value });
const integer = (value: bigint): Value => ({ kind: 'integer', value });

/**
 * 値として等しいか。**クラスが違えば等しくないだけで、誤りではない**（§6.1〜6.3）。
 *
 * **整数と小数をまたいで等しくなりうるのは数だけ**である（同じ「数」だから）。
 * **シンボルと文字列は綴りが同じでも等しくない。** クラスをまたいだ同一視は別の話で、
 * `#foo = 'foo'` と `'foo' = #foo` が食い違う実装があるが、その非対称は持ち込まない。
 *
 * **`Array` と `Interval` だけが要素で比べる**（§6.3）。そのため要素を受け取る形にしてあり、
 * 要素にはエラー（`#(1.0e400)` のような表せないリテラル）もブロックも現れうる。
 * どちらも `=` を持たないが、**`=` はエラーにならない**（§6.3 の表）ので、
 * ここで等しいかどうかだけを答える。
 *
 * **セルは保持する値で比べる**（§4.2）。`Cell` は `=` を定義せず、委譲の規則がそのまま働く。
 * 受け手としてここへ来ることはない（送信の直前に解決される）が、**範囲の列挙は
 * 配列の要素としてセルを渡す**（M3 段階 4）ので、両側を解決してから比べる。
 */
function isEqual(left: Value, right: Value): boolean {
  const receiver = heldValue(left);
  const argument = heldValue(right);

  switch (receiver.kind) {
    case 'integer':
    case 'decimal':
      return isNumber(argument) && compareNumbers(receiver, argument) === 0;
    case 'string':
      return argument.kind === 'string' && argument.value === receiver.value;
    case 'symbol':
      return argument.kind === 'symbol' && argument.value === receiver.value;
    case 'boolean':
      return argument.kind === 'boolean' && argument.value === receiver.value;
    case 'nil':
      return argument.kind === 'nil';
    case 'array':
    case 'interval':
      return argument.kind !== 'error' && isSequenceEqual(receiver, argument, isEqual);
    // **範囲だけが要素で比べない**（§6.3）。座標の対であって値の入れ物ではないためで、
    // 向きは作る時点で正規化されている（§4.3）ので端どうしを見れば足りる。
    case 'range':
      return argument.kind === 'range' && isSameRectangle(receiver, argument);
    // ブロックに `=` は無い（§5.1）。**受け手としては `sendToAny` が弾く**ので、
    // ここへ来るのは配列の要素として比べられたときだけ。等しくないとみなす。
    case 'block':
      return false;
    // エラーは受け手にならない（§6.0）。要素として比べられたときは種別で見る。
    case 'error':
      return argument.kind === 'error' && argument.error === receiver.error;
  }
}

/** 引数が数でなければ `#TypeError`（検査の順序 2）。 */
const withNumber = (argument: ReceivedValue, operation: (argument: NumberValue) => Value): Value =>
  isNumber(argument) ? operation(argument) : TYPE_ERROR;

const withString = (argument: ReceivedValue, operation: (text: string) => Value): Value =>
  argument.kind === 'string' ? operation(argument.value) : TYPE_ERROR;

/** **小数は添字になれない**ので、`copyFrom: 1.5 to: 2` は `#TypeError`（§6.2）。 */
const withInteger = (argument: ReceivedValue, operation: (value: bigint) => Value): Value =>
  argument.kind === 'integer' ? operation(argument.value) : TYPE_ERROR;

const withBoolean = (argument: ReceivedValue, operation: (value: boolean) => Value): Value =>
  argument.kind === 'boolean' ? operation(argument.value) : TYPE_ERROR;

/**
 * 遅延評価の引数を受ける。**引数はブロックでなければ `#TypeError`**（§5.2）。
 * 値を直接渡せてしまうと先行評価になり、遅延評価の要件（F-2-9）を満たさない。
 */
const withBlock = (argument: ReceivedValue, operation: (block: BlockValue) => Value): Value =>
  argument.kind === 'block' ? operation(argument) : TYPE_ERROR;

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
      case 'sqrt':
        return squareRoot(receiver);
      case 'rounded':
        return round(receiver);
      case 'truncated':
        return truncate(receiver);
      default:
        return undefined;
    }
  }

  if (second === undefined) {
    switch (selector) {
      case '+':
        return withNumber(first, (argument) => add(receiver, argument));
      case '-':
        return withNumber(first, (argument) => subtract(receiver, argument));
      case '*':
        return withNumber(first, (argument) => multiply(receiver, argument));
      case '/':
        return withNumber(first, (argument) => divide(receiver, argument));
      case '//':
        return withNumber(first, (argument) => floorDivide(receiver, argument));
      case '\\\\':
        return withNumber(first, (argument) => modulo(receiver, argument));
      // 大小は型が揃っていないと決まらないので、引数が数でなければ #TypeError（§6.1）。
      case '<':
        return withNumber(first, (argument) => boolean(compareNumbers(receiver, argument) === -1));
      case '<=':
        return withNumber(first, (argument) => boolean(compareNumbers(receiver, argument) <= 0));
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
      // **数への `to:` は区間を作る**（ADR-0016）。セルへの `to:` が作る範囲（§4.3）とは
      // 別のクラスで、逆向きの扱いも逆になる（区間は空、範囲は正規化）。
      case 'to:':
        return withNumber(first, (argument) => makeInterval(receiver, argument));
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

/** 文字列のセレクタ（§6.2）。**数え方と範囲の判定は `string.ts` が持つ。** */
function sendToString(
  receiver: StringValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  const [first, second] = args;

  if (first === undefined) {
    switch (selector) {
      case 'size':
        return integer(characterCount(receiver.value));
      case 'isEmpty':
        return boolean(receiver.value === '');
      case 'asUppercase':
        return string(upperCase(receiver.value));
      case 'asLowercase':
        return string(lowerCase(receiver.value));
      case 'asNumber':
        return parseNumber(receiver.value);
      default:
        return undefined;
    }
  }

  if (second === undefined) {
    switch (selector) {
      case ',':
        return withString(first, (text) => string(receiver.value + text));
      case 'indexOf:':
        return withString(first, (text) => integer(indexOfSubstring(receiver.value, text)));
      // 空になりうるものは String（§6.2）と Array / Interval（§6.3）。Range は空にならない。
      case 'ifEmpty:':
        return withBlock(first, (block) => (receiver.value === '' ? invoke(block, []) : receiver));
      default:
        return undefined;
    }
  }

  if (selector !== 'copyFrom:to:') return undefined;
  // 添字の型の誤りは範囲外より先に出る（§6.0 の検査の順序）。
  return withInteger(first, (from) =>
    withInteger(second, (to) => copyFrom(receiver.value, from, to)),
  );
}

/**
 * 真偽値のセレクタ（§5.2、§6.2）。
 *
 * **`&` と `|` は先行評価、`and:` と `or:` は遅延評価である。** 引数は送信の前に
 * 評価される（§3.6）ので、`&` の受け手が `false` でも引数のエラーは表に出る。
 * **短絡して引数を見ない経路でも型は検査する**（`false and: 1` は `#TypeError`）。
 */
function sendToBoolean(
  receiver: BooleanValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  const [first, second] = args;

  if (first === undefined) {
    return selector === 'not' ? boolean(!receiver.value) : undefined;
  }

  if (second === undefined) {
    switch (selector) {
      case '&':
        return withBoolean(first, (value) => boolean(receiver.value && value));
      case '|':
        return withBoolean(first, (value) => boolean(receiver.value || value));
      // **選ばれなければ評価しない**（§6.2）。Smalltalk-80 と同じく、選んだときは
      // ブロックの値をそのまま返す。真偽値を返すブロックを渡すのが本来の使い方。
      case 'and:':
        return withBlock(first, (block) => (receiver.value ? invoke(block, []) : boolean(false)));
      case 'or:':
        return withBlock(first, (block) => (receiver.value ? boolean(true) : invoke(block, [])));
      // **選ばれなければ `nil` を返す**（§5.2）。引数の型は選ばれない側でも検査する。
      case 'ifTrue:':
        return withBlock(first, (block) => (receiver.value ? invoke(block, []) : NIL));
      case 'ifFalse:':
        return withBlock(first, (block) => (receiver.value ? NIL : invoke(block, [])));
      default:
        return undefined;
    }
  }

  // **順序を入れ替えた形は別のセレクタである**（§5.2）。引数の並びが逆になるだけで、
  // 選ばれなかった側を評価しないことは同じ。
  if (selector === 'ifTrue:ifFalse:') {
    return withBlock(first, (whenTrue) =>
      withBlock(second, (whenFalse) => invoke(receiver.value ? whenTrue : whenFalse, [])),
    );
  }
  if (selector === 'ifFalse:ifTrue:') {
    return withBlock(first, (whenFalse) =>
      withBlock(second, (whenTrue) => invoke(receiver.value ? whenTrue : whenFalse, [])),
    );
  }
  return undefined;
}

/**
 * ブロックのセレクタ（§5.1）。**セレクタの綴りが引数の数を決める**ので、
 * `value` なら 0 個、`value:` なら 1 個、`value:value:` なら 2 個が `args` に並ぶ。
 * **ブロックの引数の数と合うかを見るのは `invoke` の側**で、合わなければ `#TypeError`。
 */
function sendToBlock(
  receiver: BlockValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  if (selector !== 'value' && selector !== 'value:' && selector !== 'value:value:') {
    return undefined;
  }
  return invoke(receiver, args);
}

/**
 * 並びを持つ値のセレクタ（§6.3）。**`Array` と `Interval` は同じセレクタを理解する。**
 * 違うのは要素の正体だけなので、振り分けも 1 つで足りる。**`Range` は M3 でここへ入る。**
 *
 * **演算は `sequence.ts` が持つ。** ここにあるのは引数の型の検査だけである。
 */
function sendToSequence(
  receiver: SequenceValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
  budget: StepBudget,
): Value | undefined {
  const [first, second] = args;

  if (first === undefined) {
    switch (selector) {
      case 'size':
        return integer(sequenceSize(receiver));
      case 'isEmpty':
        return boolean(sequenceSize(receiver) === 0n);
      // first / last は添字アクセスなので、空なら範囲外（集計の nil とは分ける、§6.3）。
      case 'first':
        return firstOf(receiver);
      case 'last':
        return lastOf(receiver);
      case 'sum':
        return sumOf(receiver, budget);
      case 'count':
        return countOf(receiver, budget);
      case 'min':
        return minOf(receiver, budget);
      case 'max':
        return maxOf(receiver, budget);
      case 'average':
        return averageOf(receiver, budget);
      default:
        return undefined;
    }
  }

  if (second === undefined) {
    switch (selector) {
      // **小数は添字になれない。** 型の誤りは範囲外より先に出る（§6.0 の検査の順序）。
      case 'at:':
        return withInteger(first, (index) => at(receiver, index));
      case 'collect:':
        return withBlock(first, (block) => collectWith(receiver, block, invoke, budget));
      case 'select:':
        return withBlock(first, (block) => filterWith(receiver, block, invoke, true, budget));
      case 'reject:':
        return withBlock(first, (block) => filterWith(receiver, block, invoke, false, budget));
      case 'sorted:':
        return withBlock(first, (block) => sortWith(receiver, block, invoke, budget));
      // 空になりうるものは String（§6.2）と Array / Interval（§6.3）。Range は空にならない。
      // ifEmpty: は §6.3 ではなく条件式として §5.2 の表にある。
      case 'ifEmpty:':
        return withBlock(first, (block) =>
          sequenceSize(receiver) === 0n ? invoke(block, []) : receiver,
        );
      default:
        return undefined;
    }
  }

  // 引数の型は、評価されないときも検査する（§5.2 と同じ）。見つかれば ifNone: は評価しない。
  if (selector === 'detect:ifNone:') {
    return withBlock(first, (block) =>
      withBlock(second, (none) => detectWith(receiver, block, none, invoke, budget)),
    );
  }
  // inject:into: の第 1 引数は初期値なので、型を選ばない。
  if (selector === 'inject:into:') {
    return withBlock(second, (block) => injectWith(receiver, first, block, invoke, budget));
  }
  return undefined;
}

/**
 * 受け手のクラスを選ばないセレクタ（§6.2、§5.2）。
 *
 * **`isNil` / `notNil` / `ifNil:` はすべての値が理解する。** `nil` かどうかを調べるのに
 * 受け手を選ばずに済む必要があるためで、クラスごとに書くと**足し忘れた 1 つが
 * `#DoesNotUnderstand` になる**。`=` と `~=` も同じ形をどのクラスも持つ（§6.1〜6.3）ので
 * ここに置くが、**要素で比べる `Array` / `Interval` は §6.3（段階 6）で別に足す。**
 */
function sendToAny(
  receiver: ReceivedValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
): Value | undefined {
  const [first, second] = args;

  if (first === undefined) {
    switch (selector) {
      case 'isNil':
        return boolean(receiver.kind === 'nil');
      case 'notNil':
        return boolean(receiver.kind !== 'nil');
      default:
        return undefined;
    }
  }
  if (second !== undefined) return undefined;

  // 受け手が nil でなければ引数は評価されない（§5.2）。受け手をそのまま返す。
  if (selector === 'ifNil:') {
    return withBlock(first, (block) => (receiver.kind === 'nil' ? invoke(block, []) : receiver));
  }
  // ブロックだけが `=` を持たない（§5.1）。**それ以外はどのクラスも同じ形で持つ**ので、
  // クラスごとに書くと足し忘れた 1 つが `#DoesNotUnderstand` になる。
  if (receiver.kind === 'block') return undefined;
  // = と ~= は型が違ってもエラーにならない。等しくないだけである（§6.1）。
  if (selector === '=') return boolean(isEqual(receiver, first));
  if (selector === '~=') return boolean(!isEqual(receiver, first));
  return undefined;
}

function dispatch(
  receiver: ReceivedValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
  budget: StepBudget,
): Value | undefined {
  switch (receiver.kind) {
    case 'integer':
    case 'decimal':
      return sendToNumber(receiver, selector, args);
    case 'string':
      return sendToString(receiver, selector, args, invoke);
    case 'boolean':
      return sendToBoolean(receiver, selector, args, invoke);
    case 'block':
      return sendToBlock(receiver, selector, args, invoke);
    // シンボルと nil が単独で持つセレクタは無い（§6.2）。理解するのは `sendToAny` の分だけで、
    // **シンボルは識別子であって文字の並びではない**ので `size` も `asUppercase` も持たない。
    case 'symbol':
    case 'nil':
      return undefined;
    case 'array':
    case 'interval':
      return sendToSequence(receiver, selector, args, invoke, budget);
    // **範囲の列挙と集計は M3 段階 4。** ここで理解しないセレクタは
    // `#DoesNotUnderstand` になるが、それは仕様上ありうる値でもある（`A1:B2 -3`）。
    case 'range':
      return undefined;
    // **セルは受け手として届かない。** `Cell` 自身が理解するセレクタは `evaluate.ts` が
    // 先に処理し（§4.2 の規則 1）、それ以外は保持する値へ置き換えられてから送られる（規則 2）。
    case 'cell':
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
 * @param budget 1 回の評価が使えるステップ数（要件 N-5、§7.8）。列挙だけが使う
 * @returns 送信の結果。エラーも値として返る
 */
export function sendMessage(
  receiver: ReceivedValue,
  selector: string,
  args: readonly ReceivedValue[],
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  // 検査の順序 1（§6.0）: 受け手がそのセレクタを持たない。
  return (
    sendToAny(receiver, selector, args, invoke) ??
    dispatch(receiver, selector, args, invoke, budget) ??
    DOES_NOT_UNDERSTAND
  );
}
