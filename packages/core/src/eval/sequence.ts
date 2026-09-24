/**
 * 並びを持つ値の演算（仕様書 §6.3）。
 *
 * **`Array` / `Range` / `Interval` は同じセレクタを理解し、違うのは要素の正体だけである。**
 * 要素の取り出し方だけを分け（`eachElement` / `elementAt`）、集計と列挙はその上に
 * 1 つずつ書く。**範囲の要素は `Cell`**（ADR-0015）なので、**集計だけが値へ解決する段を
 * 通る**（§6.3「集計は要素を値に解決してから扱う」）。列挙はそのまま渡す——飛ばしたり
 * 置き換えたりすると、ブロックの中でセル自身を扱えなくなる。
 *
 * **区間の要素は位置から計算する**（`start + (i - 1)`、ADR-0016）。足し込みで進めると、
 * 倍精度で 1 を足しても値が変わらない大きさ（`1e21` 付近）で上端に到達しなくなる。
 *
 * **要素を並べるのは集計と列挙だけである。** `size` / `isEmpty` / `at:` / `first` / `last`
 * は個数と位置だけで決まるので、`1 to: 1e400` のような区間にも答えられる。
 *
 * **セレクタとの対応は `send.ts` が持つ。** `number.ts` / `string.ts` と同じく、
 * ここには「引数がブロックでなければ `#TypeError`」のような送信側の検査を置かない。
 */

import type { StepBudget } from './budget.ts';
import { add, compareNumbers, divide, isNumber, type Ordering, subtract } from './number.ts';
import { rangeCellAt, rangeSize } from './range.ts';
import type { InvokeBlock } from './send.ts';
import {
  type ArrayValue,
  type BlockValue,
  type ErrorValue,
  heldValue,
  type IntegerValue,
  type IntervalValue,
  type NumberValue,
  type RangeValue,
  type ReceivedValue,
  type Value,
} from './value.ts';

const TYPE_ERROR: ErrorValue = { kind: 'error', error: 'TypeError' };
const SUBSCRIPT_OUT_OF_BOUNDS: ErrorValue = { kind: 'error', error: 'SubscriptOutOfBounds' };
const TIMEOUT: ErrorValue = { kind: 'error', error: 'Timeout' };
const NIL: Value = { kind: 'nil' };
const ZERO: NumberValue = { kind: 'integer', value: 0n };

const integer = (value: bigint): IntegerValue => ({ kind: 'integer', value });
const array = (elements: readonly ReceivedValue[]): Value => ({ kind: 'array', elements });

/** 並びを持つ値（§6.3）。 */
export type SequenceValue = ArrayValue | RangeValue | IntervalValue;

/**
 * **要素で `=` を決める並び**（§6.3）。範囲だけがここに入らない——座標の対であって
 * 値の入れ物ではないので、`=` は矩形どうしの比較になる（`range.ts`）。
 */
type ElementwiseValue = ArrayValue | IntervalValue;

/**
 * 集計と列挙の途中結果。**エラーに当たった時点で打ち切る**ので、値の並びかエラーになる。
 * 配列は `kind` を持たないので、`isFailure` がこの 2 つを見分けられる。
 */
type Collected = readonly ReceivedValue[] | ErrorValue;

const isFailure = (collected: Collected): collected is ErrorValue => 'kind' in collected;

/**
 * `Number to: Number`（ADR-0016）。**個数は `to:` の時点で決まる。**
 *
 * 求まらなければ区間は作れず `#Overflow` になる（`-1.0e308 to: 1.0e308` は差が
 * 倍精度に収まらない）。**整数の端は任意精度なので、どれだけ離れていても作れる。**
 */
export function makeInterval(start: NumberValue, stop: NumberValue): Value {
  const span = subtract(stop, start);
  // 数の減算が返すのは数かエラーだけである（§6.1）。
  if (!isNumber(span)) return span;

  // floor(stop - start) + 1。**負になる場合は 0**（§6.3）。逆向きが空になるのはここ。
  const count = (span.kind === 'integer' ? span.value : BigInt(Math.floor(span.value))) + 1n;
  return { kind: 'interval', start, stop, count: count < 0n ? 0n : count };
}

/** 要素の数。**`count` セレクタとは違う**（あちらは値が `nil` でない要素を数える）。 */
export function sequenceSize(receiver: SequenceValue): bigint {
  switch (receiver.kind) {
    case 'array':
      return BigInt(receiver.elements.length);
    case 'range':
      return rangeSize(receiver);
    case 'interval':
      return receiver.count;
  }
}

/** 区間の `i` 番目の要素（§6.3）。**位置から計算し、足し込みで進めない。** */
const intervalElement = (receiver: IntervalValue, index: bigint): Value =>
  add(receiver.start, integer(index - 1n));

/**
 * 添字で要素を取る。**添字は 1 起点**（ADR-0014）。
 *
 * @returns 要素。**範囲外なら `undefined`**（呼び出し側が `#SubscriptOutOfBounds` にする）
 */
function elementAt(receiver: SequenceValue, index: bigint): Value | undefined {
  if (index < 1n || index > sequenceSize(receiver)) return undefined;
  if (receiver.kind === 'interval') return intervalElement(receiver, index);
  // **範囲の要素は `Cell`**（ADR-0015）。位置から計算するので矩形を並べずに済む。
  if (receiver.kind === 'range') return rangeCellAt(receiver, index);
  // 添字が範囲内であることは上で確かめてあるので、`undefined` はここへ来ない。
  return receiver.elements[Number(index) - 1];
}

/** 添字アクセス（`at:` / `first` / `last`）。**空なら範囲外であって集計の `nil` ではない。** */
export const at = (receiver: SequenceValue, index: bigint): Value =>
  elementAt(receiver, index) ?? SUBSCRIPT_OUT_OF_BOUNDS;

export const firstOf = (receiver: SequenceValue): Value => at(receiver, 1n);

export const lastOf = (receiver: SequenceValue): Value => at(receiver, sequenceSize(receiver));

function* eachElement(receiver: SequenceValue): Generator<Value> {
  if (receiver.kind === 'array') {
    yield* receiver.elements;
    return;
  }
  // 矩形も区間も位置から要素が決まるので、数え方は同じでよい。
  // **範囲が行優先で進むことは `rangeCellAt` が持つ**（ADR-0015）。
  const size = sequenceSize(receiver);
  for (let index = 1n; index <= size; index += 1n) {
    yield receiver.kind === 'range'
      ? rangeCellAt(receiver, index)
      : intervalElement(receiver, index);
  }
}

/**
 * 要素を並べる。**集計と列挙だけがこれを通る。**
 *
 * **要素の数だけ先にステップを払う**（要件 N-5、§7.8）。並べる前に払うので、
 * `1 to: 1e400` のような区間は 1 歩も進まず、配列を確保する前に `#Timeout` になる。
 * **個数を先に決めてある**（ADR-0016）ことが、ここで効いている。
 *
 * 要素がエラーになりうるのは、表せないリテラルを含むリテラル配列（`#(1.0e400)`）だけで、
 * そのときは**そのエラーが式全体の値になる**（§6.0）。
 */
function elementList(receiver: SequenceValue, budget: StepBudget): Collected {
  if (!budget.spend(sequenceSize(receiver))) return TIMEOUT;

  const elements: ReceivedValue[] = [];
  for (const element of eachElement(receiver)) {
    if (element.kind === 'error') return element;
    elements.push(element);
  }
  return elements;
}

/**
 * `Array` と `Interval` の `=`（§6.3）。**同じクラスで、同じ長さで、対応する位置の
 * 要素がすべて `=`。** クラスが違えば等しくないだけで、誤りにはならない。
 *
 * @param elementsEqual 要素どうしの比較（§6.1 の `=`）。`send.ts` が持つ
 */
export function isSequenceEqual(
  receiver: ElementwiseValue,
  argument: ReceivedValue,
  elementsEqual: (a: Value, b: Value) => boolean,
): boolean {
  // **区間は要素を並べずに比べられる。** 要素が `start + (i - 1)` で決まる以上、
  // 下端と個数が一致することは、対応する位置の要素がすべて等しいことと同じである。
  // 端の書き方が違っても要素が同じなら等しい（`1 to: 3` と `1 to: 3.5`）のはこのため。
  if (receiver.kind === 'interval') {
    if (argument.kind !== 'interval' || argument.count !== receiver.count) return false;
    return receiver.count === 0n || compareNumbers(receiver.start, argument.start) === 0;
  }

  if (argument.kind !== 'array' || argument.elements.length !== receiver.elements.length) {
    return false;
  }
  return receiver.elements.every((element, index) => {
    const other = argument.elements[index];
    // 長さが等しいことは上で確かめてあるので、`undefined` はここへ来ない。
    return other !== undefined && elementsEqual(element, other);
  });
}

/**
 * 集計が見る値。**値が `nil` の要素は無視する**（ADR-0010）。
 *
 * **列挙はこれを通さない。** 飛ばすと要素数が変わり、`select:` と区別が付かなくなる（§6.3）。
 */
const presentValues = (elements: readonly ReceivedValue[]): readonly ReceivedValue[] =>
  elements.filter((element) => element.kind !== 'nil');

/**
 * 集計が見る値に解決する（§6.3）。**範囲の要素は `Cell` なので、各 `Cell` の値を見る。**
 * `Cell` そのものは `nil` ではないため、この段が無いと空セルを数えてしまう。
 *
 * **列挙はここを通らない。** 解決して渡すと、ブロックの中でセル自身を扱えなくなる。
 *
 * **解決した値がエラーなら、それが式全体の値になる**（§6.0）。それ以降の要素は見ない。
 */
function resolvedValues(elements: readonly ReceivedValue[]): readonly ReceivedValue[] | ErrorValue {
  const values: ReceivedValue[] = [];
  for (const element of elements) {
    const value = heldValue(element);
    if (value.kind === 'error') return value;
    values.push(value);
  }
  return values;
}

/** 集計の対象になる値。**要素を値に解決し、値が `nil` のものを落とす**（ADR-0010）。 */
function aggregatedValues(
  receiver: SequenceValue,
  budget: StepBudget,
): readonly ReceivedValue[] | ErrorValue {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  const values = resolvedValues(elements);
  if (isFailure(values)) return values;
  return presentValues(values);
}

/** 集計は数を要求する（`count` を除く）。**数でない値があれば `#TypeError`**（§6.3）。 */
function asNumbers(values: readonly ReceivedValue[]): readonly NumberValue[] | ErrorValue {
  const numbers: NumberValue[] = [];
  for (const value of values) {
    if (!isNumber(value)) return TYPE_ERROR;
    numbers.push(value);
  }
  return numbers;
}

/** 集計の対象になる数。値が `nil` の要素を落としてから、数であることを確かめる。 */
function aggregatedNumbers(
  receiver: SequenceValue,
  budget: StepBudget,
): readonly NumberValue[] | ErrorValue {
  const values = aggregatedValues(receiver, budget);
  return isFailure(values) ? values : asNumbers(values);
}

/** 総和。**空なら `0`**（加法の単位元、ADR-0010）。 */
function totalOf(numbers: readonly NumberValue[]): Value {
  let sum: NumberValue = ZERO;
  for (const number of numbers) {
    const next = add(sum, number);
    // 加算が返すのは数かエラーだけである（§6.1）。桁が溢れれば `#Overflow`。
    if (!isNumber(next)) return next;
    sum = next;
  }
  return sum;
}

export function sumOf(receiver: SequenceValue, budget: StepBudget): Value {
  const numbers = aggregatedNumbers(receiver, budget);
  return isFailure(numbers) ? numbers : totalOf(numbers);
}

/** `count`。**数を要求しない**ので、文字列が入っていても数える（§6.3）。 */
export function countOf(receiver: SequenceValue, budget: StepBudget): Value {
  const values = aggregatedValues(receiver, budget);
  return isFailure(values) ? values : integer(BigInt(values.length));
}

/**
 * `min` と `max`。**空なら `nil`**（単位元が無い、ADR-0010）。
 *
 * **等しければ後の要素を採る。** §6.1 の `max:` / `min:` が「等しければ比較が偽になるので
 * 引数を返す」としているのと同じで、整数と小数のどちらが残るかがそこで決まる。
 */
function extremumOf(receiver: SequenceValue, wanted: Ordering, budget: StepBudget): Value {
  const numbers = aggregatedNumbers(receiver, budget);
  if (isFailure(numbers)) return numbers;

  let best: NumberValue | undefined;
  for (const number of numbers) {
    best = best !== undefined && compareNumbers(best, number) === wanted ? best : number;
  }
  return best ?? NIL;
}

export const minOf = (receiver: SequenceValue, budget: StepBudget): Value =>
  extremumOf(receiver, -1, budget);

export const maxOf = (receiver: SequenceValue, budget: StepBudget): Value =>
  extremumOf(receiver, 1, budget);

/**
 * `average`。**空なら `nil`。** 割り算は §6.1 の `/` と同じなので、
 * 割り切れれば整数を返す。**割るのは値が `nil` でない要素の数**である（ADR-0010）。
 */
export function averageOf(receiver: SequenceValue, budget: StepBudget): Value {
  const numbers = aggregatedNumbers(receiver, budget);
  if (isFailure(numbers)) return numbers;
  if (numbers.length === 0) return NIL;

  const sum = totalOf(numbers);
  if (!isNumber(sum)) return sum;
  return divide(sum, integer(BigInt(numbers.length)));
}

/**
 * ブロックの値を条件として読む。**真偽値を返さなければ `#TypeError`**（#36）。
 *
 * §7.6 が `whileTrue:` について「受け手が真偽値以外を返せば `#TypeError`」と定めており、
 * それと同じ規則を選び出しにも当てる。**この言語は `false` 以外を真とみなす経路を
 * どこにも持たない**（`false and: 1` も `#TypeError`）。
 */
function condition(result: Value): boolean | ErrorValue {
  if (result.kind === 'error') return result;
  return result.kind === 'boolean' ? result.value : TYPE_ERROR;
}

/** **列挙の結果は常に `Array`**（§6.3）。区間に `collect:` を送っても区間は返らない。 */
export function collectWith(
  receiver: SequenceValue,
  block: BlockValue,
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  const collected: ReceivedValue[] = [];
  for (const element of elements) {
    const result = invoke(block, [element]);
    // ブロックの中で生じたエラーが式全体の値になる（§6.0）。それ以降は評価しない。
    if (result.kind === 'error') return result;
    collected.push(result);
  }
  return array(collected);
}

/**
 * `do:`。**受け手を返す**（§7.6）。値を集めるのは `collect:` の役割で、`do:` はブロックの
 * 副作用（一時変数やセルへの代入）のために回す。ブロックの値がエラーなら、そのエラーが
 * `do:` の値になる（`collect:` と同じ、§6.0）。
 */
export function doWith(
  receiver: SequenceValue,
  block: BlockValue,
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  for (const element of elements) {
    const result = invoke(block, [element]);
    if (result.kind === 'error') return result;
  }
  return receiver;
}

/**
 * `select:` と `reject:`。
 *
 * @param keep ブロックが返した真偽値のうち要素を残す方（`select:` は `true`、`reject:` は `false`）
 */
export function filterWith(
  receiver: SequenceValue,
  block: BlockValue,
  invoke: InvokeBlock,
  keep: boolean,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  const filtered: ReceivedValue[] = [];
  for (const element of elements) {
    const matched = condition(invoke(block, [element]));
    if (typeof matched !== 'boolean') return matched;
    if (matched === keep) filtered.push(element);
  }
  return array(filtered);
}

/** `detect:ifNone:`。**見つからなければ `ifNone:` を評価した値**を返す（§6.3）。 */
export function detectWith(
  receiver: SequenceValue,
  block: BlockValue,
  none: BlockValue,
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  for (const element of elements) {
    const matched = condition(invoke(block, [element]));
    if (typeof matched !== 'boolean') return matched;
    if (matched) return element;
  }
  return invoke(none, []);
}

/** `inject:into:`。ブロックは累積値と要素を受け取る（§6.3）。 */
export function injectWith(
  receiver: SequenceValue,
  initial: ReceivedValue,
  block: BlockValue,
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  let accumulated: ReceivedValue = initial;
  for (const element of elements) {
    const next = invoke(block, [accumulated, element]);
    if (next.kind === 'error') return next;
    accumulated = next;
  }
  return accumulated;
}

/**
 * 併合整列。**同順（どちらの向きにも偽）の要素は元の並びを保つ**ので安定である（#36）。
 *
 * **実行環境の `sort` に任せない。** 決定性が要件（F-4-4）である以上、比較が不整合な
 * ブロック（`[:a :b | true]`）を渡されたときの結果も一意でなければならないが、
 * そこは整列法ごとに変わる。併合整列なら比較の順序と結果がどの述語に対しても定まる。
 *
 * @param precedes 左の要素が右より前に来るか。真偽値以外とエラーはそのまま返る
 */
function mergeSort(
  elements: readonly ReceivedValue[],
  precedes: (a: ReceivedValue, b: ReceivedValue) => boolean | ErrorValue,
): Collected {
  if (elements.length <= 1) return elements;

  const middle = elements.length >> 1;
  const left = mergeSort(elements.slice(0, middle), precedes);
  if (isFailure(left)) return left;
  const right = mergeSort(elements.slice(middle), precedes);
  if (isFailure(right)) return right;

  const merged: ReceivedValue[] = [];
  let taken = 0;
  let other = 0;
  while (taken < left.length && other < right.length) {
    const a = left[taken];
    const b = right[other];
    // 添字は上の条件で押さえてあるので、`undefined` はここへ来ない。
    if (a === undefined || b === undefined) break;

    // **右が左より前に来るときだけ右を採る。** 同順なら左が残るので安定になる。
    const takeRight = precedes(b, a);
    if (typeof takeRight !== 'boolean') return takeRight;
    if (takeRight) {
      merged.push(b);
      other += 1;
    } else {
      merged.push(a);
      taken += 1;
    }
  }
  return [...merged, ...left.slice(taken), ...right.slice(other)];
}

/** `sorted:`。**返り値は `Array`**（§6.3）。比較のブロックは引数を 2 つ取る。 */
export function sortWith(
  receiver: SequenceValue,
  block: BlockValue,
  invoke: InvokeBlock,
  budget: StepBudget,
): Value {
  const elements = elementList(receiver, budget);
  if (isFailure(elements)) return elements;

  const sorted = mergeSort(elements, (a, b) => condition(invoke(block, [a, b])));
  return isFailure(sorted) ? sorted : array(sorted);
}
