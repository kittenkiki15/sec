import { describe, expect, it } from 'vitest';
import { LexicalError } from './lexer.ts';
import {
  type Body,
  type MacroDefinition,
  ParseError,
  parseFormula,
  parseMacroBody,
  parseMacroDefinition,
  type Statement,
} from './parser.ts';

/**
 * 木の形を 1 行で書く。S 式に寄せた表記で、`(受け手 セレクタ 引数...)` の順に並べる。
 * **値の表記（§0.3）とは別物。** ここで見たいのは木の形であって、評価結果の見せ方ではない。
 */
const show = (node: Statement): string => {
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
      return `[${node.parameters.map((name) => `:${name}`).join(' ')} | ${showBody(node)}]`;
    case 'assign':
      return `(${show(node.target)} := ${show(node.value)})`;
    case 'return':
      return `(^ ${show(node.value)})`;
    case 'send':
      return `(${show(node.receiver)} ${node.selector}${node.arguments.map((argument) => ` ${show(argument)}`).join('')})`;
  }
};

/** 一時変数の宣言と文の列。マクロの本体とマクロのブロックが同じ形を持つ（§7.2、§7.5）。 */
const showBody = (body: Body): string => {
  const temporaries = body.temporaries.length > 0 ? `|${body.temporaries.join(' ')}| ` : '';
  return `${temporaries}${body.statements.map(show).join('. ')}`;
};

const tree = (source: string): string => show(parseFormula(source));

/** マクロの本体を木にする。**原文は行で書く方が仕様書と見比べやすい。** */
const macro = (...source: string[]): string => showBody(parseMacroBody(source.join('\n')));

/** マクロの定義を木にする。宣言部を `セレクタ(引数...)` の形で頭に付ける。 */
const definition = (...source: string[]): string => {
  const node: MacroDefinition = parseMacroDefinition(source.join('\n'));
  return `${node.selector}(${node.parameters.join(' ')}) ${showBody(node.body)}`;
};

/**
 * 構文エラーの中身（位置・説明文）を確かめるために捕まえる。
 * **字句と構文のどちらで見つかっても利用者には同じ `#Syntax`** なので、両方を受ける。
 */
const errorFrom = (
  source: string,
  parse: (source: string) => unknown = parseFormula,
): LexicalError | ParseError => {
  try {
    parse(source);
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

const rejectsMacro = (...source: string[]): void => {
  expect(errorFrom(source.join('\n'), parseMacroBody).message).not.toBe('');
};

const rejectsDefinition = (...source: string[]): void => {
  expect(errorFrom(source.join('\n'), parseMacroDefinition).message).not.toBe('');
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
        temporaries: [],
        statements: [{ kind: 'integer', value: 3n }],
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

  describe('§5.1 名前の影と二重宣言', () => {
    it('入れ子のブロックは外側の引数と同じ名前を宣言できない', () => {
      rejects('[:x | [:x | x] value: 1] value: 2');
    });

    it('同じ並びに同じ名前を 2 つ書けない', () => {
      rejects('[:x :x | x] value: 1 value: 2');
    });

    it('外側と違う名前なら入れ子にできる', () => {
      expect(tree('[:x | [:y | x + y] value: 1] value: 2')).toBe(
        '([:x | ([:y | (x + y)] value: 1)] value: 2)',
      );
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

describe('parseMacroBody', () => {
  describe('§7.2 文の列', () => {
    it('^ で値を返す', () => {
      expect(macro('^ 3')).toBe('(^ 3)');
    });

    it('文は . で区切る', () => {
      expect(macro('1 + 1.', '^ 2 + 2')).toBe('(1 + 1). (^ (2 + 2))');
    });

    it('末尾の . は書いてよい', () => {
      expect(macro('^ 3.')).toBe('(^ 3)');
      expect(macro('1 + 1.')).toBe('(1 + 1)');
    });

    it('^ が無ければ返却の無い文の列になる', () => {
      expect(macro('1 + 1')).toBe('(1 + 1)');
    });

    it('文が空になる区切りは書けない', () => {
      rejectsMacro('1 + 1. . ^ 2');
      rejectsMacro('. ^ 1');
    });

    it('^ の後ろに文を続けられない', () => {
      rejectsMacro('^ 1.', '2 + 2');
      rejectsMacro('^ 1. ^ 2');
    });

    it('本体には文が 1 つ以上要る', () => {
      rejectsMacro('');
      rejectsMacro('   "コメントだけ" ');
    });

    it('返却は文であって式ではない', () => {
      rejectsMacro('^ ^ 1');
      rejectsMacro('1 + ^ 2');
    });
  });

  describe('§7.2 一時変数', () => {
    it('宣言した名前を持つ', () => {
      expect(macro('| a |', 'a := 3.', '^ a + 1')).toBe('|a| (a := 3). (^ (a + 1))');
    });

    it('名前は 1 つの宣言に並べる', () => {
      expect(macro('| a b |', 'a := 3.', 'b := 4.', '^ a + b')).toBe(
        '|a b| (a := 3). (b := 4). (^ (a + b))',
      );
    });

    it('何も宣言しない形も書ける', () => {
      expect(macro('| |', '^ 1')).toBe('(^ 1)');
    });

    it('宣言は本体の先頭にだけ置ける', () => {
      rejectsMacro('| a |', 'a := 1.', '| b |', '^ a');
    });

    it('宣言を 2 つに分けられない', () => {
      rejectsMacro('| a |', '| b |', '^ 1');
    });

    it('同じ名前を二重に宣言できない', () => {
      rejectsMacro('| a a |', '^ 1');
    });

    it('宣言だけで文が無い本体は書けない', () => {
      rejectsMacro('| a |');
    });

    it('宣言が閉じていないのは構文エラー', () => {
      rejectsMacro('| a', '^ 1');
      rejectsMacro('| a 1 |', '^ 1');
    });
  });

  describe('§7.3 代入', () => {
    it('宣言済みの一時変数に代入できる', () => {
      expect(macro('| a |', 'a := 3.', '^ a')).toBe('|a| (a := 3). (^ a)');
    });

    it('空白の無い a:=1 も代入（§1.4）', () => {
      expect(macro('| a |', 'a:=3.', '^ a')).toBe('|a| (a := 3). (^ a)');
    });

    it('右辺は式ならなんでもよい', () => {
      expect(macro('| a |', 'a := A1 squared.', '^ a')).toBe('|a| (a := (A1 squared)). (^ a)');
    });

    it('宣言の無い識別子への代入は構文エラー', () => {
      rejectsMacro('a := 1.', '^ 1');
    });

    it('宣言の無い識別子を読むのは構文エラーではない（§4.2 の #Ref）', () => {
      expect(macro('^ total')).toBe('(^ total)');
    });

    it('代入は式ではないので式の中に現れない', () => {
      rejectsMacro('| a |', '^ 3 + (a := 1)');
      rejectsMacro('| a |', '^ 3 max: (a := 5)');
      rejectsMacro('| a |', '^ [a := 1] value + (a := 2)');
    });

    it('連鎖代入も書けない', () => {
      rejectsMacro('| a b |', 'a := b := 3.', '^ a');
    });

    it('左辺になれるのは一時変数とセル参照だけ', () => {
      rejectsMacro('3 := 1.', '^ 3');
      rejectsMacro('nil := 1.', '^ 1');
      rejectsMacro('| a |', 'a squared := 1.', '^ a');
    });

    it('範囲への代入は書けない（§7.9、未決論点 D-4）', () => {
      rejectsMacro('A1:B2 := 0.', '^ A1');
    });
  });

  describe('§7.4 セルへの代入', () => {
    it('セル参照を左辺に書ける（ADR-0007 D-3）', () => {
      expect(macro('A1 := 3.', '^ A1')).toBe('(A1 := 3). (^ A1)');
    });

    it('右辺は式でよい', () => {
      expect(macro('B1 := (A1 to: A2) sum.', '^ B1')).toBe('(B1 := ((A1 to: A2) sum)). (^ B1)');
    });

    it('左辺のセルは宣言を要らない', () => {
      expect(macro('A1 := A1 + 1.', '^ A1')).toBe('(A1 := (A1 + 1)). (^ A1)');
    });
  });

  describe('§7.5 マクロのブロック', () => {
    it('ブロックの本体は文の列と一時変数を持てる', () => {
      expect(macro('^ [:x | | t | t := x * 2. t + 1] value: 3')).toBe(
        '(^ ([:x | |t| (t := (x * 2)). (t + 1)] value: 3))',
      );
    });

    it('文をいくつでも並べられる', () => {
      expect(macro('^ [1. 2. 3] value')).toBe('(^ ([ | 1. 2. 3] value))');
    });

    it('外側の一時変数に代入できる', () => {
      expect(macro('| a |', '^ [a := 1] value')).toBe('|a| (^ ([ | (a := 1)] value))');
    });

    it('外側と同じ名前を内側で宣言できない', () => {
      rejectsMacro('| a |', '^ [| a | a] value');
    });

    it('ブロック引数と同じ名前の一時変数も宣言できない', () => {
      rejectsMacro('^ [:x | | x | x] value: 1');
    });

    it('ブロック引数が外側の名前を影にすることもできない', () => {
      rejectsMacro('| a |', '^ [:a | a] value: 1');
    });

    it('本体が空のブロックは書けない（§5.1 と同じ）', () => {
      rejectsMacro('^ [] value');
      rejectsMacro('^ [:x | ] value: 1');
    });

    it('引数は 0〜2 個（要件 F-2-5）', () => {
      rejectsMacro('^ [:x :y :z | x] value: 1');
    });

    it('閉じていないブロックは構文エラー', () => {
      rejectsMacro('^ [1. 2');
      rejectsMacro('| a |', '^ [a := 1');
    });
  });

  describe('§7.5 非局所リターン', () => {
    it('ブロックの中の ^ を木に載せる', () => {
      expect(macro('#(1 2 3) do: [:e | e > 1 ifTrue: [^ e]].', '^ 0')).toBe(
        '(#(1 2 3) do: [:e | ((e > 1) ifTrue: [ | (^ e)])]). (^ 0)',
      );
    });

    it('ブロックの中でも ^ は文の列の最後にだけ書ける', () => {
      rejectsMacro('^ [^ 1. 2] value');
    });

    it('ブロックの中の ^ の後ろに末尾の . は書ける', () => {
      expect(macro('^ [^ 1.] value')).toBe('(^ ([ | (^ 1)] value))');
    });
  });

  describe('§7.7 数式との境界', () => {
    it('同じ原文でも開始記号で結果が変わる', () => {
      expect(macro('^ 3')).toBe('(^ 3)');
      rejects('^ 3');
    });

    it('数式が受ける式はマクロでも受ける', () => {
      expect(macro('3 + 4 * 2')).toBe('((3 + 4) * 2)');
      expect(macro('#(1 2 3) do: [:e | e]')).toBe('(#(1 2 3) do: [:e | e])');
    });
  });

  describe('要件 F-8-3 位置と説明文', () => {
    it('構文エラーは行と列を持つ', () => {
      const error = errorFrom(['| a |', 'b := 1.', '^ a'].join('\n'), parseMacroBody);
      expect(error.line).toBe(2);
      expect(error.column).toBe(1);
      expect(error.message).not.toBe('');
    });

    it('位置は問題のあるトークンを指す', () => {
      const error = errorFrom(['| a |', '^ 3 + (a := 1)'].join('\n'), parseMacroBody);
      expect(error.line).toBe(2);
      expect(error.column).toBe(10);
    });
  });
});

describe('parseMacroDefinition', () => {
  describe('§7.1 マクロの宣言', () => {
    it('単項セレクタを名前にできる', () => {
      expect(definition('monthlyTotal', '| total |', 'total := 3.', '^ total')).toBe(
        'monthlyTotal() |total| (total := 3). (^ total)',
      );
    });

    it('キーワードパターンは引数を取る', () => {
      expect(definition('from: start to: end', '^ start + end')).toBe(
        'from:to:(start end) (^ (start + end))',
      );
    });

    it('引数は本体の中で識別子として読める', () => {
      expect(definition('summarize: label', 'A14 := label.', '^ A14')).toBe(
        'summarize:(label) (A14 := label). (^ A14)',
      );
    });

    it('引数への代入は書けない（§7.3）', () => {
      rejectsDefinition('double: n', 'n := n * 2.', '^ n');
    });

    it('引数と同じ名前を本体で宣言できない', () => {
      rejectsDefinition('double: n', '| n |', '^ n');
      rejectsDefinition('double: n', '^ [:n | n] value: 1');
    });

    it('同じ名前の引数を 2 つ取れない', () => {
      rejectsDefinition('from: a to: a', '^ a');
    });

    it('二項セレクタのパターンは認めない', () => {
      rejectsDefinition('+ other', '^ other');
    });

    it('キーワードには識別子が続く', () => {
      rejectsDefinition('from: 1 to: end', '^ end');
      rejectsDefinition('from:', '^ 1');
    });

    it('宣言部だけで本体が無いものは書けない（§7.2）', () => {
      rejectsDefinition('monthlyTotal');
      rejectsDefinition('summarize: label');
    });

    it('宣言部が無いものも書けない', () => {
      rejectsDefinition('^ 3');
      rejectsDefinition('| total |', '^ total');
    });
  });
});
