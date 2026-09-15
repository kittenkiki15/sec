/**
 * 数の演算（仕様書 §6.1）。**整数は任意精度、小数は IEEE754 倍精度**（ADR-0012）。
 *
 * ここが引き受けるのは §6.1「変換と範囲」の規則である。
 *
 * - **整数と小数が混ざる演算は小数を返す**（伝染）。整数どうしなら任意精度のまま
 * - **小数が必要になった時点で被演算子を小数へ変換する。** 結果を正確に求めてから
 *   変換するのではない。変換できなければ `#Overflow`（ADR-0013）
 * - **比較は大きさを比べるだけ**なので変換を必要とせず、`#Overflow` にならない
 *
 * **セレクタとの対応は `send.ts` が持つ。** ここには「引数が数でなければ `#TypeError`」
 * のような送信側の検査を置かない。数どうしの演算だけを閉じた形にしておくと、
 * §6.1 の表を読みながら確かめられる。
 */

import type { ErrorValue, NumberValue, Value } from './value.ts';

/** 大小の比較結果。**`#Overflow` になりえない**ので、エラーを混ぜない型にしてある。 */
export type Ordering = -1 | 0 | 1;

export const isNumber = (value: Value): value is NumberValue =>
  value.kind === 'integer' || value.kind === 'decimal';

const OVERFLOW: ErrorValue = { kind: 'error', error: 'Overflow' };
const DIVIDE_BY_ZERO: ErrorValue = { kind: 'error', error: 'DivideByZero' };

/**
 * 被演算子を小数へ変換する。**表せなければ `null`。**
 * 小数はもともと有限なので（ADR-0013）、変換が要るのは整数の側だけである。
 */
function widen(value: NumberValue): number | null {
  if (value.kind === 'decimal') return value.value;
  const widened = Number(value.value);
  return Number.isFinite(widened) ? widened : null;
}

/**
 * 小数の結果を値にする。**非有限なら `#Overflow`。**
 * 小さすぎる値は `0.0` に丸まった形でここへ来るので、エラーにはならない（§6.1）。
 */
const decimalResult = (value: number): Value =>
  Number.isFinite(value) ? { kind: 'decimal', value } : OVERFLOW;

/**
 * `+` `-` `*` の共通部分。整数どうしは任意精度のまま、混ざれば双方を小数へ変換する。
 * 変換で表せなくなった時点で `#Overflow` になるので、`1e400 + 0.0` は結果を見るまでもない。
 */
function arithmetic(
  receiver: NumberValue,
  argument: NumberValue,
  onIntegers: (a: bigint, b: bigint) => bigint,
  onDecimals: (a: number, b: number) => number,
): Value {
  if (receiver.kind === 'integer' && argument.kind === 'integer') {
    return { kind: 'integer', value: onIntegers(receiver.value, argument.value) };
  }

  const a = widen(receiver);
  const b = widen(argument);
  if (a === null || b === null) return OVERFLOW;
  return decimalResult(onDecimals(a, b));
}

export const add = (receiver: NumberValue, argument: NumberValue): Value =>
  arithmetic(
    receiver,
    argument,
    (a, b) => a + b,
    (a, b) => a + b,
  );

export const subtract = (receiver: NumberValue, argument: NumberValue): Value =>
  arithmetic(
    receiver,
    argument,
    (a, b) => a - b,
    (a, b) => a - b,
  );

export const multiply = (receiver: NumberValue, argument: NumberValue): Value =>
  arithmetic(
    receiver,
    argument,
    (a, b) => a * b,
    (a, b) => a * b,
  );

/** 負のゼロも 0 である。`-0.0` で割るのも 0 で割ること。 */
const isZero = (value: NumberValue): boolean =>
  value.kind === 'integer' ? value.value === 0n : value.value === 0;

/**
 * `/`。**整数を返すのは両方が整数で、かつ割り切れるときだけ**（§6.1）。
 * 片方でも小数なら、割り切れても小数になる。
 */
export function divide(receiver: NumberValue, argument: NumberValue): Value {
  // 検査の順序（§6.0）: 「演算が成り立つか」を「値を表せるか」より先に見る。
  // だから `1e400 / 0.0` は #Overflow ではなく #DivideByZero になる。
  if (isZero(argument)) return DIVIDE_BY_ZERO;

  if (receiver.kind === 'integer' && argument.kind === 'integer') {
    if (receiver.value % argument.value === 0n) {
      return { kind: 'integer', value: receiver.value / argument.value };
    }
  }

  const a = widen(receiver);
  const b = widen(argument);
  if (a === null || b === null) return OVERFLOW;
  return decimalResult(a / b);
}

export const absoluteValue = (value: NumberValue): NumberValue =>
  value.kind === 'integer'
    ? { kind: 'integer', value: value.value < 0n ? -value.value : value.value }
    : { kind: 'decimal', value: Math.abs(value.value) };

export const negate = (value: NumberValue): NumberValue =>
  value.kind === 'integer'
    ? { kind: 'integer', value: -value.value }
    : { kind: 'decimal', value: -value.value };

const compareIntegers = (a: bigint, b: bigint): Ordering => (a < b ? -1 : a > b ? 1 : 0);
const compareDecimals = (a: number, b: number): Ordering => (a < b ? -1 : a > b ? 1 : 0);
const flip = (ordering: Ordering): Ordering => (ordering === 0 ? 0 : ordering === 1 ? -1 : 1);

/**
 * 整数と小数を**倍精度へ落とさずに**比べる。
 *
 * 受け手を倍精度にすると桁が落ちて大小が逆転しうる
 * （`9007199254740993` は倍精度では `9007199254740992` になる）。
 * 小数を整数部と端数に分ければ、任意精度の整数とそのまま突き合わせられる。
 * 小数は有限なので（ADR-0013）、整数部は必ず取れる。
 */
function compareIntegerWithDecimal(a: bigint, b: number): Ordering {
  const truncated = Math.floor(b);
  const whole = BigInt(truncated);
  if (a !== whole) return a < whole ? -1 : 1;
  // 整数部が等しいなら、端数の有無が大小を決める。
  return b > truncated ? -1 : 0;
}

/**
 * 値として比べる（`1 = 1.0` は等しい）。**変換を伴わないので `#Overflow` にならない。**
 * `1e400 > 1.0` が `true` になるのはこのためである（§6.1）。
 */
export function compareNumbers(receiver: NumberValue, argument: NumberValue): Ordering {
  if (receiver.kind === 'integer') {
    return argument.kind === 'integer'
      ? compareIntegers(receiver.value, argument.value)
      : compareIntegerWithDecimal(receiver.value, argument.value);
  }
  return argument.kind === 'integer'
    ? flip(compareIntegerWithDecimal(argument.value, receiver.value))
    : compareDecimals(receiver.value, argument.value);
}
