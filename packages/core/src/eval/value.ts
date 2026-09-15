/**
 * 数式の評価結果となる値と、その表記。
 *
 * **表記は仕様書 §0.3 が定める。** ゴールデンテストの期待値に書く形であり、
 * **評価結果を人間に見せるときの形でもある**（CLI と Web UI も `printValue` を使う）。
 * 形を 1 箇所に集めておかないと、同じ値が場所によって違う字面で出る。
 *
 * **エラーも値である**（要件 F-8-1）。ただしエラーはメッセージを受け取らない。
 * エラーになった時点で評価が打ち切られるため（§6.0）。
 */

import { isBareSymbolSpelling } from '../syntax/lexer.ts';

/** 要件 F-8-2 が定めるエラーの種別。**表記にはこの綴りだけを書く**（文言と位置は含めない）。 */
export type ErrorKind =
  | 'Syntax'
  | 'DoesNotUnderstand'
  | 'TypeError'
  | 'DivideByZero'
  | 'Circular'
  | 'Ref'
  | 'Timeout'
  | 'Overflow'
  | 'SubscriptOutOfBounds';

/** 整数。桁数に上限が無いため任意精度で持つ（ADR-0012）。 */
export interface IntegerValue {
  readonly kind: 'integer';
  readonly value: bigint;
}

/** 小数。IEEE754 倍精度（ADR-0012）。**非有限の値は取らない**（ADR-0013 で `#Overflow`）。 */
export interface DecimalValue {
  readonly kind: 'decimal';
  readonly value: number;
}

export interface StringValue {
  readonly kind: 'string';
  readonly value: string;
}

/** シンボル。`#` を外した綴りを持つ（`#at:put:` なら `at:put:`）。 */
export interface SymbolValue {
  readonly kind: 'symbol';
  readonly value: string;
}

export interface BooleanValue {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface NilValue {
  readonly kind: 'nil';
}

export interface ArrayValue {
  readonly kind: 'array';
  readonly elements: readonly Value[];
}

export interface ErrorValue {
  readonly kind: 'error';
  readonly error: ErrorKind;
}

/**
 * 数式の評価結果（§6.0 の値の分類）。
 * `Range` / `Interval` / `Cell` は送信かセル参照が要るため、まだ無い。
 */
export type Value =
  | IntegerValue
  | DecimalValue
  | StringValue
  | SymbolValue
  | BooleanValue
  | NilValue
  | ArrayValue
  | ErrorValue;

/** 指数表記に切り替える境界（ADR-0017）。**この数値に理論的な必然性は無い。** */
const EXPONENT_UPPER = 1e21;
const EXPONENT_LOWER = 1e-6;

/** `'` で囲み、内部の `'` を二重にする（§0.3）。文字列とシンボルで同じ。 */
const quote = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/**
 * 小数を書く。**小数点を必ず付ける**ことで、表記だけで整数と見分けられる状態を保つ。
 *
 * 仮数と通常表記の桁は JavaScript の最短往復表記をそのまま使う。ADR-0017 が
 * 「仮数は最短往復表記の桁で」としており、`Number` の既定の変換がこれにあたる。
 */
function printDecimal(value: number): string {
  // 負のゼロも `0.0`（§0.3）。`String(-0)` は "0" なので下の分岐でも同じ字面になるが、
  // 0 は指数表記の条件から外れることを先に示しておく。
  if (value === 0) return '0.0';

  const magnitude = Math.abs(value);
  if (magnitude >= EXPONENT_UPPER || magnitude < EXPONENT_LOWER) {
    const [mantissa = '', exponent = ''] = value.toExponential().split('e');
    // 指数の `+` は付けない。仮数には小数点を必ず付ける。
    return `${mantissa.includes('.') ? mantissa : `${mantissa}.0`}e${exponent.replace('+', '')}`;
  }

  const text = String(value);
  return text.includes('.') ? text : `${text}.0`;
}

/**
 * 値を仕様書 §0.3 の表記にする。
 *
 * @param value 表記する値
 * @returns ゴールデンテストの期待値と突き合わせられる字面
 */
export function printValue(value: Value): string {
  switch (value.kind) {
    case 'integer':
      return value.value.toString();
    case 'decimal':
      return printDecimal(value.value);
    case 'string':
      return quote(value.value);
    case 'symbol':
      // 識別子・キーワードセレクタ・二項セレクタとして書けない綴りだけ引用符で囲む（§2.3）。
      return `#${isBareSymbolSpelling(value.value) ? value.value : quote(value.value)}`;
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'nil':
      return 'nil';
    case 'array':
      // 入れ子の配列にも `#` が付く。要素の表記は種別に従うだけなので、そのまま辿る。
      return `#(${value.elements.map(printValue).join(' ')})`;
    case 'error':
      return `#${value.error}`;
  }
}
