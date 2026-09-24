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

import { type CellAddress, printAddress } from '../model/address.ts';
import { isBareSymbolSpelling } from '../syntax/lexer.ts';
import type { Body } from '../syntax/parser.ts';

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

/**
 * 数の区間（§6.3、[ADR-0016](../../../../docs/adr/0016-number-interval.md)）。
 * **要素は数で、刻みは 1。** `Number to: Number` で作る。
 *
 * **個数を先に決め、要素は位置から計算する**（`i` 番目は `start + (i - 1)`）。
 * 足し込みで進めると、倍精度で 1 を足しても値が変わらない大きさ（`1e21` 付近）で
 * 上端に到達せず、列挙が終わらなくなる。
 *
 * **個数は `to:` の時点で決まる。** 求まらない区間は値として存在しない（`#Overflow`）。
 * `stop` を持つのは表記のためだけで（§0.3 は端をそのまま書くと定める）、
 * **要素は `start` と `count` から決まるので振る舞いには関わらない。**
 */
export interface IntervalValue {
  readonly kind: 'interval';
  readonly start: NumberValue;
  readonly stop: NumberValue;
  /** 要素の数。`floor(stop - start) + 1`。負になる場合は `0`（逆向きは空、ADR-0016）。 */
  readonly count: bigint;
}

/**
 * 名前 1 つの入れ物。**一時変数への代入はこの中身を書き換える**（§7.3）。
 *
 * 表に値を直に置くと、ブロックを起動するたびに表を写したとき、写しへの書き込みが
 * 外側に届かない（`[:x | a := x] value: 5` の後も `a` が変わらない）。**入れ物を写せば、
 * 写した表どうしが同じ入れ物を指す。** 引数は代入できない（構文解析器が弾く）ので、
 * 書き換わるのは一時変数の入れ物だけである。
 */
export interface Binding {
  value: ReceivedValue;
}

/**
 * 識別子から入れ物への束縛（§5.1、§7.3）。**平らな表 1 つで足りる。**
 * 外側と同じ名前を内側で宣言できない（§5.1、§7.5）ので、名前が衝突することがなく、
 * 内と外を分けて持って**どちらを先に見るかを決める必要が無い**ためである。
 */
export type Environment = ReadonlyMap<string, Binding>;

/**
 * ブロック（§5.1）。**評価を遅らせるための値**で、作るだけでは本体を評価しない。
 * 本体を木のまま持つのは、`value` を送られて初めて評価するため。
 *
 * **作られた時点の環境を捕まえる。** `[:x | [x + 1]] value: 2` の内側のブロックは、
 * 外側の送信が終わった後に評価されても `x` を見られなければならない。
 */
export interface BlockValue {
  readonly kind: 'block';
  /** 0〜2 個（要件 F-2-5）。数が合わない `value` の送信は `#TypeError`。 */
  readonly parameters: readonly string[];
  readonly body: Body;
  readonly environment: Environment;
}

export interface ErrorValue {
  readonly kind: 'error';
  readonly error: ErrorKind;
}

/**
 * セル（§4.2、[ADR-0008](../../../../docs/adr/0008-cell-value-delegation.md)）。
 * **`Cell` 自身が理解するのは `value` と `to:`** で、それ以外は保持する値へ委譲する。
 *
 * **保持する値を持たず、引く手段だけを持つ。** §4.3 が「範囲は座標の対でしかなく、
 * 作るだけならセルに値が入っている必要はない」と定めており、`A1 to: B10` は委譲を
 * 起こさない。**値を抱えると、範囲を作るだけで両端を読むことになる。**
 * 数式セルの値は他のセルに依存する（M3 段階 5）ので、読む回数は少ない方がよい。
 */
export interface CellValue {
  readonly kind: 'cell';
  readonly address: CellAddress;
  readonly values: CellValues;
}

/**
 * 範囲（§4.3）。**正規化した矩形**で、矩形そのものは左上と右下の番地の対でしかない。
 *
 * **セルの値を持たず、`Cell` と同じく引く手段だけを持つ。** 範囲は座標の対であって
 * 値の入れ物ではなく（§4.3）、`=` も矩形だけで決まる（§6.3）。**値を抱えると、
 * 範囲を作るだけで矩形の全セルを読むことになる。** 中身を読むのは列挙と集計だけで、
 * **列挙が渡す要素は `Cell`**（ADR-0015）なので、要素にそのまま渡す手段でもある。
 *
 * **向きは作る時点で正規化する**（`range.ts`）。値になった後の矩形は常に
 * 左上 → 右下の向きなので、**読む側が向きを気にしなくてよい。**
 */
export interface RangeValue {
  readonly kind: 'range';
  readonly topLeft: CellAddress;
  readonly bottomRight: CellAddress;
  readonly values: CellValues;
}

/**
 * セルが保持しうる値。**セルはセルを保持しない**——内容の解釈（§4.4）が返すのは
 * §2 のリテラルの値か数式の評価結果であり、どちらもセルにはならない。
 */
export type HeldValue = Exclude<Value, CellValue>;

/**
 * 番地からそのセルが保持する値を答える（§4.2）。
 *
 * **シートそのものではない。** 数式セルの値は再計算の結果であり（要件 F-4）、
 * シートは原文しか持たない。**その段を挟むのが目的の型**で、M3 段階 5 では
 * 再計算エンジンがこれになる。
 */
export type CellValues = (address: CellAddress) => HeldValue;

/** 数式の評価結果（§6.0 の値の分類）。 */
export type Value =
  | IntegerValue
  | DecimalValue
  | StringValue
  | SymbolValue
  | BooleanValue
  | NilValue
  | ArrayValue
  | IntervalValue
  | RangeValue
  | BlockValue
  | CellValue
  | ErrorValue;

/**
 * セルなら保持する値、それ以外はそのまま（§4.2 の委譲）。
 *
 * **送信の直前に受け手と引数へ当てるのが規則 2 である**（`evaluate.ts`）。
 * ここに置いてあるのは、配列の要素として渡ったセルを比べるときにも同じ解決が要るため
 * （範囲の列挙が要素にセルを渡す、M3 段階 4）。
 */
export function heldValue(value: Value): HeldValue {
  return value.kind === 'cell' ? value.values(value.address) : value;
}

/**
 * 受け手と引数に現れうる値。**エラーはメッセージを受け取らない**（§6.0）。
 * エラーになった時点で評価が打ち切られるので、送信まで届くことがない。
 * 型で表しておくと、打ち切りを忘れた経路が型検査で落ちる。
 */
export type ReceivedValue = Exclude<Value, ErrorValue>;

/** 整数と小数（§6.1）。**混ざる演算は小数を返す**（伝染）。 */
export type NumberValue = IntegerValue | DecimalValue;

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
    // 区間は端をそのまま書く（§0.3）。**個数は表記に出ない**ので、`5 to: 1` は
    // 空であってもそう書く。要素を並べないのは、整数の端が任意精度だからでもある。
    case 'interval':
      return `${printValue(value.start)} to: ${printValue(value.stop)}`;
    // **糖衣で書いても表記は正準形になる**（§4.3）。両端は正規化した番地なので、
    // `A007..A3` も `A3 to: A7` と書く（ADR-0020）。
    case 'range':
      return `${printAddress(value.topLeft)} to: ${printAddress(value.bottomRight)}`;
    // 引数の数も本体も表記しない（§5.1）。原文をそのまま書くと、空白の入れ方を
    // 変えただけでゴールデンテストが落ちる（エラーに文言を含めない理由と同じ）。
    case 'block':
      return 'aBlock';
    // **セルの表記は保持する値の表記に従う**（§4.2）。番地は出ない。
    case 'cell':
      return printValue(heldValue(value));
    case 'error':
      return `#${value.error}`;
  }
}
