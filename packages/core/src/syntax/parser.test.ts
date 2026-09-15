import { describe, expect, it } from 'vitest';
import { LexicalError } from './lexer.ts';
import { type Expression, ParseError, parseFormula } from './parser.ts';

/**
 * 木の形を 1 行で書く。S 式に寄せた表記で、`(受け手 セレクタ 引数...)` の順に並べる。
 * **値の表記（§0.3）とは別物。** ここで見たいのは木の形であって、評価結果の見せ方ではない。
 */
const show = (node: Expression): string => {
  switch (node.kind) {
    case 'integer':
      return node.value.toString();
    case 'decimal':
      return Number.isInteger(node.value) ? `${node.value}.0` : `${node.value}`;
    case 'string':
      return `'${node.value}'`;
    case 'symbol':
      return `#${node.value}`;
    case 'boolean':
      return `${node.value}`;
    case 'nil':
      return 'nil';
    case 'array':
      return `#(${node.elements.map(show).join(' ')})`;
    case 'error':
      return `#${node.error}`;
    case 'identifier':
      return node.name;
    case 'cell':
      return node.name;
    case 'block':
      return `[${node.parameters.map((name) => `:${name}`).join(' ')} | ${show(node.body)}]`;
    case 'send':
      return `(${show(node.receiver)} ${node.selector}${node.arguments.map((argument) => ` ${show(argument)}`).join('')})`;
  }
};

const tree = (source: string): string => show(parseFormula(source));

/**
 * 構文エラーの中身（位置・説明文）を確かめるために捕まえる。
 * **字句と構文のどちらで見つかっても利用者には同じ `#Syntax`** なので、両方を受ける。
 */
const errorFrom = (source: string): LexicalError | ParseError => {
  try {
    parseFormula(source);
  } catch (error) {
    if (error instanceof ParseError || error instanceof LexicalError) return error;
    throw error;
  }
  throw new Error(`構文エラーになりませんでした: ${source}`);
};

/** 位置を見ないケース用。説明文が空でないことだけは常に確かめる（要件 F-8-3）。 */
const rejects = (source: string): void => {
  expect(errorFrom(source).message).not.toBe('');
};

describe('parseFormula', () => {
  describe('§2.1 数値', () => {
    it('整数は任意精度で持つ', () => {
      const node = parseFormula('9007199254740993');
      expect(node).toEqual({ kind: 'integer', value: 9007199254740993n });
    });

    it('先頭の 0 は無視する', () => {
      expect(parseFormula('007')).toEqual({ kind: 'integer', value: 7n });
    });

    it('小数は倍精度で持つ', () => {
      expect(parseFormula('0.1')).toEqual({ kind: 'decimal', value: 0.1 });
      expect(parseFormula('3.14')).toEqual({ kind: 'decimal', value: 3.14 });
    });

    it('仮数が整数で指数が非負なら整数', () => {
      expect(parseFormula('1e3')).toEqual({ kind: 'integer', value: 1000n });
    });

    it('仮数に小数点があるか指数が負なら小数', () => {
      expect(parseFormula('1.5e3')).toEqual({ kind: 'decimal', value: 1500 });
      expect(parseFormula('2e-3')).toEqual({ kind: 'decimal', value: 0.002 });
    });

    it('整数のリテラルに桁数の上限は無い', () => {
      expect(parseFormula('1e400')).toEqual({ kind: 'integer', value: 10n ** 400n });
    });

    it('倍精度で表せない小数は #Overflow（§2.1）', () => {
      expect(parseFormula('1.0e400')).toEqual({ kind: 'error', error: 'Overflow' });
    });

    it('桁が落ちるだけならエラーにしない（ADR-0013）', () => {
      expect(parseFormula('1.0e-400')).toEqual({ kind: 'decimal', value: 0 });
    });

    it('負のリテラルは符号を値に含める', () => {
      expect(parseFormula('-5')).toEqual({ kind: 'integer', value: -5n });
      expect(parseFormula('-0.5')).toEqual({ kind: 'decimal', value: -0.5 });
      expect(parseFormula('-1e3')).toEqual({ kind: 'integer', value: -1000n });
    });

    it('直前が一次式の終端なら - は二項セレクタ（§2.1）', () => {
      expect(tree('3 -4')).toBe('(3 - 4)');
      expect(tree('3 - -4')).toBe('(3 - -4)');
    });
  });

  describe('§2.2 文字列', () => {
    it('引用符を外した中身を持つ', () => {
      expect(parseFormula("'abc'")).toEqual({ kind: 'string', value: 'abc' });
    });

    it('二重の引用符は 1 つの引用符に戻す', () => {
      expect(parseFormula("'It''s'")).toEqual({ kind: 'string', value: "It's" });
    });

    it('空文字列を書ける', () => {
      expect(parseFormula("''")).toEqual({ kind: 'string', value: '' });
    });

    it('改行はそのまま文字列の一部になる', () => {
      expect(parseFormula("'a\nb'")).toEqual({ kind: 'string', value: 'a\nb' });
    });
  });

  describe('§2.3 シンボル', () => {
    it('# を外した綴りを持つ', () => {
      expect(parseFormula('#foo')).toEqual({ kind: 'symbol', value: 'foo' });
      expect(parseFormula('#at:put:')).toEqual({ kind: 'symbol', value: 'at:put:' });
      expect(parseFormula('#+')).toEqual({ kind: 'symbol', value: '+' });
    });

    it('識別子にできない綴りは引用符で囲む', () => {
      expect(parseFormula("#'hello world'")).toEqual({ kind: 'symbol', value: 'hello world' });
    });

    it('#A1 はシンボルであってセル参照ではない', () => {
      expect(parseFormula('#A1')).toEqual({ kind: 'symbol', value: 'A1' });
    });
  });

  describe('§2.4 リテラル配列', () => {
    it('要素を並べた配列になる', () => {
      expect(tree('#(1 2 3)')).toBe('#(1 2 3)');
    });

    it('空の配列を書ける', () => {
      expect(parseFormula('#()')).toEqual({ kind: 'array', elements: [] });
    });

    it('種別の違う要素を混ぜられる', () => {
      expect(tree("#(1 'two' #three true nil)")).toBe("#(1 'two' #three true nil)");
    });

    it('裸の識別子はシンボルになる', () => {
      expect(tree('#(foo bar)')).toBe('#(#foo #bar)');
    });

    it('裸のキーワードセレクタもシンボルになる', () => {
      expect(tree('#(at:put:)')).toBe('#(#at:put:)');
    });

    it('裸のキーワードは隣り合っているときだけ 1 つのセレクタになる', () => {
      expect(tree('#(at: put:)')).toBe('#(#at: #put:)');
      expect(tree('#(at:put: foo)')).toBe('#(#at:put: #foo)');
      expect(tree('#(at:foo)')).toBe('#(#at: #foo)');
    });

    it('裸の二項セレクタもシンボルになる。式は書けない', () => {
      expect(tree('#(1 + 2)')).toBe('#(1 #+ 2)');
      expect(tree('#(1-2)')).toBe('#(1 #- 2)');
    });

    it('入れ子の配列は # を省ける', () => {
      expect(tree('#(1 (2 3))')).toBe('#(1 #(2 3))');
      expect(tree('#(1 #(2 3))')).toBe('#(1 #(2 3))');
    });

    it('予約語はシンボルではなくその値になる', () => {
      expect(tree('#(true false nil)')).toBe('#(true false nil)');
    });

    it('要素の間の空白は、隣接してもトークンが分かれるなら要らない', () => {
      expect(tree("#(1'foo')")).toBe("#(1 'foo')");
      expect(tree('#(12)')).toBe('#(12)');
    });

    it('閉じていない配列は構文エラー', () => {
      rejects('#(1 2');
    });

    it('要素になれないものは構文エラー', () => {
      rejects('#([1])');
      rejects('#(A1)');
    });
  });

  describe('§2.5 真偽値と nil', () => {
    it('予約語はそれぞれの値になる', () => {
      expect(parseFormula('true')).toEqual({ kind: 'boolean', value: true });
      expect(parseFormula('false')).toEqual({ kind: 'boolean', value: false });
      expect(parseFormula('nil')).toEqual({ kind: 'nil' });
    });
  });

  describe('§3.2-3.4 メッセージ式', () => {
    it('単項メッセージは左から右へ送る', () => {
      expect(tree('5 abs')).toBe('(5 abs)');
      expect(tree('3 negated abs')).toBe('((3 negated) abs)');
    });

    it('二項メッセージは引数を 1 つ取る', () => {
      expect(tree('3 + 4')).toBe('(3 + 4)');
    });

    it('複数のキーワードは連結して 1 つのセレクタになる', () => {
      expect(tree('3 max: 4')).toBe('(3 max: 4)');
      expect(tree('3 between: 1 and: 5')).toBe('(3 between:and: 1 5)');
    });

    it('セレクタの有無は構文解析器が決めない', () => {
      expect(tree('3 max: 4 min: 2')).toBe('(3 max:min: 4 2)');
    });

    it('キーワードメッセージは括弧なしに入れ子にできない', () => {
      expect(tree('(3 max: 4) min: 2')).toBe('((3 max: 4) min: 2)');
    });
  });

  describe('§3.5 優先順位', () => {
    it('二項メッセージに優先順位は無く、左から順に送る', () => {
      expect(tree('3 + 4 * 2')).toBe('((3 + 4) * 2)');
      expect(tree('2 * 3 + 4')).toBe('((2 * 3) + 4)');
      expect(tree('1 + 2 > 2')).toBe('((1 + 2) > 2)');
    });

    it('丸括弧が最も強い', () => {
      expect(tree('3 + (4 * 2)')).toBe('(3 + (4 * 2))');
    });

    it('単項は二項より強い', () => {
      expect(tree('2 * 3 squared')).toBe('(2 * (3 squared))');
      expect(tree('1 + 2 squared')).toBe('(1 + (2 squared))');
    });

    it('二項はキーワードより強い', () => {
      expect(tree('3 max: 1 + 4')).toBe('(3 max: (1 + 4))');
      expect(tree('1 + 4 max: 3')).toBe('((1 + 4) max: 3)');
    });

    it('3 つの順位が混ざっても単項 > 二項 > キーワードの順に結び付く', () => {
      expect(tree('2 max: 3 + 4 squared')).toBe('(2 max: (3 + (4 squared)))');
      expect(tree('1 + 2 * 3 squared')).toBe('((1 + 2) * (3 squared))');
    });
  });

  describe('§4 セル参照と範囲', () => {
    it('セル参照は原文の綴りを持つ', () => {
      expect(parseFormula('A1')).toEqual({ kind: 'cell', name: 'A1' });
      expect(parseFormula('AB12')).toEqual({ kind: 'cell', name: 'AB12' });
    });

    it('範囲の糖衣は to: の送信へ脱糖する', () => {
      const canonical = '(A1 to: B10)';
      expect(tree('A1:B10')).toBe(canonical);
      expect(tree('A1..B10')).toBe(canonical);
      expect(tree('A1 to: B10')).toBe(canonical);
    });

    it('脱糖した範囲は一次式として式に現れる', () => {
      expect(tree('A1:B10 sum')).toBe('((A1 to: B10) sum)');
      expect(tree('(A1:B10) sum + 1')).toBe('(((A1 to: B10) sum) + 1)');
    });

    it('糖衣の両辺はセル参照でなければならない', () => {
      rejects('3..5');
      rejects('A1..5');
    });

    it('区切りの前後に空白は挟めない', () => {
      rejects('A1 .. B10');
      rejects('A1.. B10');
      rejects('A1 : B10');
    });

    it('範囲の書き損ねは範囲の規則を説明する（要件 F-8-3）', () => {
      expect(errorFrom('A1 .. B10').message).toContain('範囲');
      expect(errorFrom('A1 : B10').message).toContain('範囲');
      expect(errorFrom('3..5').message).toContain('範囲');
    });
  });

  describe('§5.1 ブロック', () => {
    it('引数の無いブロックは本体だけを持つ', () => {
      expect(parseFormula('[3]')).toEqual({
        kind: 'block',
        parameters: [],
        body: { kind: 'integer', value: 3n },
      });
    });

    it('引数は 0〜2 個', () => {
      expect(tree('[:x | x * 2]')).toBe('[:x | (x * 2)]');
      expect(tree('[:x :y | x + y]')).toBe('[:x :y | (x + y)]');
    });

    it('3 個以上の引数は構文エラー', () => {
      rejects('[:x :y :z | x]');
    });

    it('本体が空のブロックは構文エラー', () => {
      rejects('[]');
    });

    it('ブロックは一次式なのでメッセージを送れる', () => {
      expect(tree('[3 + 4] value')).toBe('([ | (3 + 4)] value)');
      expect(tree('1 > 2 ifTrue: [1] ifFalse: [2]')).toBe(
        '((1 > 2) ifTrue:ifFalse: [ | 1] [ | 2])',
      );
    });

    it('閉じていないブロックは構文エラー', () => {
      rejects('[3 + 4');
      rejects('[:x | x');
    });

    it('引数の並びが | で閉じていないブロックは構文エラー', () => {
      rejects('[:x x]');
    });

    it(': に識別子が続かないブロックは構文エラー', () => {
      rejects('[:1 | 1]');
      rejects('[: | 1]');
    });
  });

  describe('§3.8 構文エラー', () => {
    it('二項セレクタに項が足りない', () => {
      rejects('3 +');
      rejects('+ 3');
    });

    it('キーワードに受け手や引数が足りない', () => {
      rejects('3 max:');
      rejects('max: 3');
    });

    it('丸括弧が閉じていない', () => {
      rejects('(3 + 4');
    });

    it('空の丸括弧は式ではない', () => {
      rejects('()');
    });

    it('空の原文は式ではない', () => {
      rejects('');
      rejects('   "コメントだけ" ');
    });

    it('式の後ろに余りがあってはならない', () => {
      rejects('3 4');
      rejects('(3) (4)');
    });

    it('カスケードはどの文法にも現れない（§3.9）', () => {
      rejects('3 + 4; foo');
    });

    it('位置と説明文を持つ（要件 F-8-3）', () => {
      const error = errorFrom('3 + ');
      expect(error.line).toBe(1);
      expect(error.column).toBe(5);
      expect(error.message).not.toBe('');
    });

    it('位置は余分なトークンの側を指す', () => {
      const error = errorFrom('3\n  4');
      expect(error.line).toBe(2);
      expect(error.column).toBe(3);
    });
  });

  describe('§7 数式が拒む構文', () => {
    it('代入は数式に書けない（要件 F-2-10）', () => {
      rejects('a := 1');
      rejects('A1 := 1');
      rejects('3 + (a := 1)');
      rejects('3 max: (a := 5)');
    });

    it('文の区切りと返却は数式に書けない', () => {
      rejects('1. 2');
      rejects('^ 3');
      rejects('3 + 4.');
    });

    it('一時変数の宣言は数式に書けない', () => {
      rejects('| a | 1');
    });

    it('マクロのブロックの本体も数式には書けない（§5.1）', () => {
      rejects('[| t | 1]');
      rejects('[1. 2]');
      rejects('[^ 1]');
      rejects('[:x | | t | t := x. t]');
    });
  });
});
