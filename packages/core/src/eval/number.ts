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
 * 小数として求めた商と、変換後の被演算子。**商が表せなければ `null`。**
 *
 * `/` `//` `\\` の 3 つが同じ商を経由する。**`\\` が `//` と同じ条件で `#Overflow` に
 * なるのはこのため**で（§6.1）、`self = (self // n) * n + (self \\ n)` を保つには
 * 剰余も商から求めるほかない。
 */
function decimalDivision(
  receiver: NumberValue,
  argument: NumberValue,
): { readonly a: number; readonly b: number; readonly quotient: number } | null {
  const a = widen(receiver);
  const b = widen(argument);
  if (a === null || b === null) return null;

  const quotient = a / b;
  return Number.isFinite(quotient) ? { a, b, quotient } : null;
}

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

  const division = decimalDivision(receiver, argument);
  return division === null ? OVERFLOW : { kind: 'decimal', value: division.quotient };
}

/**
 * 床除算の商。**負の無限大の側へ丸める**（Smalltalk-80）。
 * bigint の `/` は 0 の側へ丸めるので、割り切れず符号が違うときだけ 1 つ下へ送る。
 */
function floorDivideIntegers(a: bigint, b: bigint): bigint {
  const quotient = a / b;
  return a % b !== 0n && a < 0n !== b < 0n ? quotient - 1n : quotient;
}

/**
 * `//`。**返り値は常に整数**（§6.1）。
 *
 * **整数どうしなら整数演算のままなので範囲の制限が無い。** 小数が混ざる場合は
 * 商を小数で求めてから床を取るので、そこで超えれば `#Overflow` になる。
 */
export function floorDivide(receiver: NumberValue, argument: NumberValue): Value {
  if (isZero(argument)) return DIVIDE_BY_ZERO;

  if (receiver.kind === 'integer' && argument.kind === 'integer') {
    return { kind: 'integer', value: floorDivideIntegers(receiver.value, argument.value) };
  }

  const division = decimalDivision(receiver, argument);
  if (division === null) return OVERFLOW;
  return { kind: 'integer', value: BigInt(Math.floor(division.quotient)) };
}

/**
 * `\\`。**符号は除数に合わせる**（§6.1）。`//` と対になり、
 * `self = (self // n) * n + (self \\ n)` が常に成り立つ。
 *
 * **整数を返すのは `//` だけで、こちらは小数を返しうる**（`7.5 \\ 2` → `1.5`）。
 */
export function modulo(receiver: NumberValue, argument: NumberValue): Value {
  if (isZero(argument)) return DIVIDE_BY_ZERO;

  if (receiver.kind === 'integer' && argument.kind === 'integer') {
    // bigint の `%` は受け手に符号を合わせるので、除数と食い違うときだけ寄せ直す。
    const remainder = receiver.value % argument.value;
    const matchesDivisor = remainder === 0n || remainder < 0n === argument.value < 0n;
    return { kind: 'integer', value: matchesDivisor ? remainder : remainder + argument.value };
  }

  const division = decimalDivision(receiver, argument);
  if (division === null) return OVERFLOW;
  return decimalResult(division.a - Math.floor(division.quotient) * division.b);
}

/**
 * `sqrt`。**常に小数を返す**（`4 sqrt` も `2.0`）。一般に無理数になるため。
 *
 * **受け手を小数へ変換するのが先**なので、`1e400 sqrt` は結果の `1e200` が表せても
 * `#Overflow` になる。負の数の平方根は実数の範囲に無いので、これも `#Overflow`（ADR-0013）。
 */
export function squareRoot(value: NumberValue): Value {
  const widened = widen(value);
  if (widened === null || widened < 0) return OVERFLOW;
  return decimalResult(Math.sqrt(widened));
}

/**
 * `rounded` / `truncated` の共通部分。**どちらも常に整数を返す**（§6.1）。
 * 整数に送っても整数のままなので、そのとき丸めは要らない。
 */
const toInteger = (value: NumberValue, rule: (value: number) => number): NumberValue =>
  value.kind === 'integer' ? value : { kind: 'integer', value: BigInt(rule(value.value)) };

/**
 * **端数がちょうど半分なら大きい側へ**丸める（Smalltalk-80 の `rounded`）。
 * `-2.5 rounded` は `-3` ではなく `-2`。`Math.round` が同じ規則で丸める。
 */
export const round = (value: NumberValue): NumberValue => toInteger(value, Math.round);

/** **0 の側へ落とす。** `-3.7 truncated` は `-4` ではなく `-3`。 */
export const truncate = (value: NumberValue): NumberValue => toInteger(value, Math.trunc);

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
