/**
 * 並びを持つ値の演算（仕様書 §6.3）。
 *
 * **`Array` と `Interval` は同じセレクタを理解し、違うのは要素の正体だけである。**
 * 要素の取り出し方だけを分け（`eachElement` / `elementAt`）、集計と列挙はその上に
 * 1 つずつ書く。**`Range` が 3 つ目として乗る**（M3）。そのときは要素が `Cell` になり、
 * 集計の前に値へ解決する段が要る（§6.3「集計は要素を値に解決してから扱う」）。
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

import { add, compareNumbers, divide, isNumber, type Ordering, subtract } from './number.ts';
import type { InvokeBlock } from './send.ts';
import type {
  ArrayValue,
  BlockValue,
  ErrorValue,
  IntegerValue,
  IntervalValue,
  NumberValue,
  ReceivedValue,
  Value,
} from './value.ts';

const TYPE_ERROR: ErrorValue = { kind: 'error', error: 'TypeError' };
const SUBSCRIPT_OUT_OF_BOUNDS: ErrorValue = { kind: 'error', error: 'SubscriptOutOfBounds' };
const NIL: Value = { kind: 'nil' };
const ZERO: NumberValue = { kind: 'integer', value: 0n };

const integer = (value: bigint): IntegerValue => ({ kind: 'integer', value });
const array = (elements: readonly ReceivedValue[]): Value => ({ kind: 'array', elements });

/** 並びを持つ値。**`Range` は M3 でここへ入る**（§6.3）。 */
export type SequenceValue = ArrayValue | IntervalValue;

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
export const sequenceSize = (receiver: SequenceValue): bigint =>
  receiver.kind === 'array' ? BigInt(receiver.elements.length) : receiver.count;

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
  // 範囲は上で確かめてあるので、`undefined` はここへ来ない。
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
  for (let index = 1n; index <= receiver.count; index += 1n) {
    yield intervalElement(receiver, index);
  }
}

/**
 * 要素を並べる。**集計と列挙だけがこれを通る。**
 *
 * 要素がエラーになりうるのは、表せないリテラルを含むリテラル配列（`#(1.0e400)`）だけで、
 * そのときは**そのエラーが式全体の値になる**（§6.0）。
 */
function elementList(receiver: SequenceValue): Collected {
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
  receiver: SequenceValue,
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
function aggregatedNumbers(receiver: SequenceValue): readonly NumberValue[] | ErrorValue {
  const elements = elementList(receiver);
  if (isFailure(elements)) return elements;
  return asNumbers(presentValues(elements));
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

export function sumOf(receiver: SequenceValue): Value {
  const numbers = aggregatedNumbers(receiver);
  return isFailure(numbers) ? numbers : totalOf(numbers);
}

/** `count`。**数を要求しない**ので、文字列が入っていても数える（§6.3）。 */
export function countOf(receiver: SequenceValue): Value {
  const elements = elementList(receiver);
  if (isFailure(elements)) return elements;
  return integer(BigInt(presentValues(elements).length));
}

/**
 * `min` と `max`。**空なら `nil`**（単位元が無い、ADR-0010）。
 *
 * **等しければ後の要素を採る。** §6.1 の `max:` / `min:` が「等しければ比較が偽になるので
 * 引数を返す」としているのと同じで、整数と小数のどちらが残るかがそこで決まる。
 */
function extremumOf(receiver: SequenceValue, wanted: Ordering): Value {
  const numbers = aggregatedNumbers(receiver);
  if (isFailure(numbers)) return numbers;

  let best: NumberValue | undefined;
  for (const number of numbers) {
    best = best !== undefined && compareNumbers(best, number) === wanted ? best : number;
  }
  return best ?? NIL;
}

export const minOf = (receiver: SequenceValue): Value => extremumOf(receiver, -1);

export const maxOf = (receiver: SequenceValue): Value => extremumOf(receiver, 1);

/**
 * `average`。**空なら `nil`。** 割り算は §6.1 の `/` と同じなので、
 * 割り切れれば整数を返す。**割るのは値が `nil` でない要素の数**である（ADR-0010）。
 */
export function averageOf(receiver: SequenceValue): Value {
  const numbers = aggregatedNumbers(receiver);
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
): Value {
  const elements = elementList(receiver);
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
 * `select:` と `reject:`。
 *
 * @param keep ブロックが返した真偽値のうち要素を残す方（`select:` は `true`、`reject:` は `false`）
 */
export function filterWith(
  receiver: SequenceValue,
  block: BlockValue,
  invoke: InvokeBlock,
  keep: boolean,
): Value {
  const elements = elementList(receiver);
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
): Value {
  const elements = elementList(receiver);
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
): Value {
  const elements = elementList(receiver);
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
export function sortWith(receiver: SequenceValue, block: BlockValue, invoke: InvokeBlock): Value {
  const elements = elementList(receiver);
  if (isFailure(elements)) return elements;

  const sorted = mergeSort(elements, (a, b) => condition(invoke(block, [a, b])));
  return isFailure(sorted) ? sorted : array(sorted);
}
