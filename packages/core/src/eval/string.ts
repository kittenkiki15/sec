/**
 * 文字列の演算（仕様書 §6.2）。**添字は 1 起点で、範囲外は `#SubscriptOutOfBounds`**
 * （ADR-0014）。文字型を持たないので、部分文字列を取る `indexOf:` がその代わりになる。
 *
 * **セレクタとの対応は `send.ts` が持つ。** `number.ts` と同じく、ここには
 * 「引数が文字列でなければ `#TypeError`」のような送信側の検査を置かない。
 *
 * **非 ASCII の扱いは暫定である。** 仕様書の付録 B は 2 点を未決にしている ——
 * (1) `size` と添字が何を 1 と数えるか、(2) 大文字小文字が ASCII 外をどう写すか ——
 * が、**実装は何かを選ばざるを得ない**ので次のように決めた（#32）。**付録 B は未決のまま。**
 *
 * - **数えるのはコードポイント。** 字句解析器が列をコードポイントで数えるのと揃えた
 * - **写像は JavaScript の既定**（ロケールに依存しない Unicode の写像）
 */

import { LexicalError, type Token, tokenize } from '../syntax/lexer.ts';
import { numberNode } from '../syntax/parser.ts';
import type { ErrorValue, Value } from './value.ts';

const SUBSCRIPT_OUT_OF_BOUNDS: ErrorValue = { kind: 'error', error: 'SubscriptOutOfBounds' };
const NIL: Value = { kind: 'nil' };

/** コードポイントの並びにする。**何を 1 と数えるかはここだけが決めている。** */
const codePoints = (text: string): string[] => [...text];

/** `size`。返すのは整数なので `bigint`（ADR-0012）。 */
export const characterCount = (text: string): bigint => BigInt(codePoints(text).length);

export const upperCase = (text: string): string => text.toUpperCase();

export const lowerCase = (text: string): string => text.toLowerCase();

/**
 * `indexOf:`。**見つからなければ `0`**（Smalltalk-80）。添字が 1 起点なので、
 * `0` は「ありえない位置」として機能する。**空文字列は常に先頭で見つかる。**
 *
 * コードポイントの並びの上で探すのは、返す添字が `copyFrom:to:` の添字と
 * 同じ数え方でなければならないため。`String.indexOf` の返り値は UTF-16 の位置で、
 * サロゲートペアを含む文字列では食い違う。
 */
export function indexOfSubstring(text: string, needle: string): bigint {
  const haystack = codePoints(text);
  const pattern = codePoints(needle);

  for (let start = 0; start + pattern.length <= haystack.length; start += 1) {
    if (haystack.slice(start, start + pattern.length).join('') === needle) return BigInt(start + 1);
  }
  return 0n;
}

/**
 * `copyFrom:to:`。**`to` が `from - 1` に等しいときだけ空文字列を返す**（Smalltalk-80）。
 * それより小さければ範囲外である。**添字は 1 起点なので `0` は常に範囲外**（ADR-0014）。
 *
 * `from <= size + 1` を別に見ないのは、`from - 1 <= to <= size` から従うためである。
 */
export function copyFrom(text: string, from: bigint, to: bigint): Value {
  const characters = codePoints(text);
  const size = BigInt(characters.length);

  if (from < 1n || to < from - 1n || to > size) return SUBSCRIPT_OUT_OF_BOUNDS;
  return { kind: 'string', value: characters.slice(Number(from) - 1, Number(to)).join('') };
}

/**
 * `asNumber`。**受理するのは §2.1 の数値リテラルの形ちょうど**で、読めなければ `nil`。
 *
 * **新しい規則を書かず字句解析器に読ませる。** そうしておくと、リテラルとして書ける形と
 * 文字列から読める形が常に一致する。**綴りを原文と突き合わせる**のは、前後の空白や
 * コメントがトークンにならず、`' 42'` が `42` として読めてしまうためである。
 *
 * **倍精度に収まらない小数は `#Overflow`**（#32）。形は §2.1 に合っているので
 * 「読めなかった」のではなく、リテラル `1.0e400` と同じく値として存在しない（ADR-0013）。
 * 整数には桁数の上限が無いため、`'1e400'` はそのまま整数になる。
 */
export function parseNumber(text: string): Value {
  let tokens: Token[];
  try {
    tokens = tokenize(text);
  } catch (error) {
    // 閉じていないコメントなどは字句エラーになるが、利用者から見れば読めなかっただけ。
    if (error instanceof LexicalError) return NIL;
    throw error;
  }

  const [token] = tokens;
  if (token === undefined || tokens.length !== 1) return NIL;
  if (token.kind !== 'integer' && token.kind !== 'decimal') return NIL;
  if (token.text !== text) return NIL;

  const node = numberNode(token);
  switch (node.kind) {
    case 'integer':
      return { kind: 'integer', value: node.value };
    case 'decimal':
      return { kind: 'decimal', value: node.value };
    case 'error':
      return { kind: 'error', error: node.error };
  }
}
