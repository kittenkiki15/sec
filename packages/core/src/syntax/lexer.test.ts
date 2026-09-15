import { describe, expect, it } from 'vitest';
import { LexicalError, tokenize } from './lexer.ts';

/** 種別と原文だけを見る。位置は専用のテストで確かめる。 */
const kinds = (source: string): string[] => tokenize(source).map((t) => `${t.kind}:${t.text}`);

/** 字句エラーの中身（位置・説明文）を確かめるために捕まえる。 */
const errorFrom = (source: string): LexicalError => {
  try {
    tokenize(source);
  } catch (error) {
    if (error instanceof LexicalError) return error;
    throw error;
  }
  throw new Error(`字句エラーになりませんでした: ${source}`);
};

describe('tokenize', () => {
  describe('§1.1 空白とコメント', () => {
    it('空白の量は切り出しに影響しない', () => {
      const expected = ['integer:3', 'binary:+', 'integer:4'];
      expect(kinds('3+4')).toEqual(expected);
      expect(kinds('3   +   4')).toEqual(expected);
    });

    it('改行とタブも空白として扱う', () => {
      expect(kinds('3\n  +\n  4')).toEqual(['integer:3', 'binary:+', 'integer:4']);
      expect(kinds('3\t+\t4')).toEqual(['integer:3', 'binary:+', 'integer:4']);
    });

    it('コメントは空白と同じ扱いで、式の途中にも置ける', () => {
      expect(kinds('3 "ここはコメント" + 4')).toEqual(['integer:3', 'binary:+', 'integer:4']);
    });

    it('コメントの中の " は二重にして書く', () => {
      expect(kinds('3 + "引用符は "" と書く" 4')).toEqual(['integer:3', 'binary:+', 'integer:4']);
    });

    it('コメントは改行を跨げる', () => {
      expect(kinds('3 + "ここで\n改行しても良い" 4')).toEqual([
        'integer:3',
        'binary:+',
        'integer:4',
      ]);
    });

    it('閉じていないコメントは字句エラー', () => {
      const error = errorFrom('3 + 4 "閉じていない');
      expect(error.line).toBe(1);
      expect(error.column).toBe(7);
      expect(error.message).not.toBe('');
    });

    it('空のソースはトークンを 1 つも返さない', () => {
      expect(tokenize('   \n\t')).toEqual([]);
    });
  });

  describe('§1.2 識別子とセル参照', () => {
    it('識別子は英字か _ で始まる', () => {
      expect(kinds('total _tmp a1 Abc123 A')).toEqual([
        'identifier:total',
        'identifier:_tmp',
        'identifier:a1',
        'identifier:Abc123',
        'identifier:A',
      ]);
    });

    it('大文字の英字に続いて数字の形は常にセル参照', () => {
      expect(kinds('A1 AB12')).toEqual(['cell:A1', 'cell:AB12']);
    });

    it('非 ASCII 文字は識別子に使えない', () => {
      const error = errorFrom('3 + あ');
      expect(error.line).toBe(1);
      expect(error.column).toBe(5);
    });
  });

  describe('§1.3 予約語', () => {
    it('true / false / nil は予約語', () => {
      expect(kinds('true false nil')).toEqual(['reserved:true', 'reserved:false', 'reserved:nil']);
    });

    it('予約語を接頭辞に持つ綴りは識別子', () => {
      expect(kinds('nilable')).toEqual(['identifier:nilable']);
    });
  });

  describe('§1.4 セレクタ', () => {
    it('識別子に : が続けばキーワード', () => {
      expect(kinds('3 max: 4')).toEqual(['integer:3', 'keyword:max:', 'integer:4']);
      expect(kinds('3 max:4')).toEqual(['integer:3', 'keyword:max:', 'integer:4']);
    });

    it('キーワードの識別子と : の間に空白を置けない', () => {
      expect(kinds('3 max : 4')).toEqual([
        'integer:3',
        'identifier:max',
        'colon::',
        'integer:4',
      ]);
    });

    it('二項セレクタは最長一致で 1〜2 文字', () => {
      expect(kinds('3 >= 3')).toEqual(['integer:3', 'binary:>=', 'integer:3']);
      expect(kinds('1 +++ 2')).toEqual(['integer:1', 'binary:++', 'binary:+', 'integer:2']);
      expect(kinds('1 <==> 2')).toEqual([
        'integer:1',
        'binary:<=',
        'binary:==',
        'binary:>',
        'integer:2',
      ]);
    });

    it('| は二項セレクタとして切り出し、役割は構文上の位置に委ねる', () => {
      expect(kinds('| a |')).toEqual(['binary:|', 'identifier:a', 'binary:|']);
      expect(kinds('||')).toEqual(['binary:||']);
    });

    it('カスケードの ; はトークンにしない', () => {
      expect(() => tokenize('3 ; 4')).toThrow(LexicalError);
    });
  });

  describe('§2.1 数値', () => {
    it('整数は先頭の 0 を含めてそのまま切り出す', () => {
      expect(kinds('42 0 007')).toEqual(['integer:42', 'integer:0', 'integer:007']);
    });

    it('小数は小数点の両側に数字が要る', () => {
      expect(kinds('3.14 0.5')).toEqual(['decimal:3.14', 'decimal:0.5']);
    });

    it('.5 と 5. は小数にならない', () => {
      expect(kinds('.5')).toEqual(['period:.', 'integer:5']);
      expect(kinds('5.')).toEqual(['integer:5', 'period:.']);
    });

    it('指数は仮数の種別を変えない。指数が負なら小数', () => {
      expect(kinds('1e3')).toEqual(['integer:1e3']);
      expect(kinds('1.5e3')).toEqual(['decimal:1.5e3']);
      expect(kinds('2e-3')).toEqual(['decimal:2e-3']);
    });

    it('指数の e は小文字だけ。1E3 は 1 と セル参照 E3 に切れる', () => {
      expect(kinds('1E3')).toEqual(['integer:1', 'cell:E3']);
    });

    it('e の後ろに数字が無ければ指数にしない', () => {
      expect(kinds('3e')).toEqual(['integer:3', 'identifier:e']);
      expect(kinds('2e-x')).toEqual(['integer:2', 'identifier:e', 'binary:-', 'identifier:x']);
    });

    it('直前のトークンが無ければ - は負のリテラルの一部', () => {
      expect(kinds('-5')).toEqual(['integer:-5']);
      expect(kinds('-5 abs')).toEqual(['integer:-5', 'identifier:abs']);
      expect(kinds('-0.5')).toEqual(['decimal:-0.5']);
    });

    it('直前が二項セレクタやキーワードなら - は負のリテラルの一部', () => {
      expect(kinds('3 + -4')).toEqual(['integer:3', 'binary:+', 'integer:-4']);
      expect(kinds('3 - -4')).toEqual(['integer:3', 'binary:-', 'integer:-4']);
      expect(kinds('3 max: -4')).toEqual(['integer:3', 'keyword:max:', 'integer:-4']);
    });

    it('直前が一次式の終端なら - は二項セレクタ', () => {
      expect(kinds('3 -4')).toEqual(['integer:3', 'binary:-', 'integer:4']);
      expect(kinds('3-4')).toEqual(['integer:3', 'binary:-', 'integer:4']);
      expect(kinds("'a' -1")).toEqual(["string:'a'", 'binary:-', 'integer:1']);
      expect(kinds('true -1')).toEqual(['reserved:true', 'binary:-', 'integer:1']);
      expect(kinds('total -1')).toEqual(['identifier:total', 'binary:-', 'integer:1']);
      expect(kinds('A1 -1')).toEqual(['cell:A1', 'binary:-', 'integer:1']);
      expect(kinds('(1 + 2) -3')).toEqual([
        'leftParen:(',
        'integer:1',
        'binary:+',
        'integer:2',
        'rightParen:)',
        'binary:-',
        'integer:3',
      ]);
      expect(kinds('[3] -1')).toEqual([
        'leftBracket:[',
        'integer:3',
        'rightBracket:]',
        'binary:-',
        'integer:1',
      ]);
    });

    it('範囲トークンも一次式の終端なので、その後の - は二項セレクタ', () => {
      expect(kinds('A1:B2 -3')).toEqual(['range:A1:B2', 'binary:-', 'integer:3']);
    });

    it('二項セレクタの最長一致は負のリテラルより先に効く', () => {
      expect(kinds('3--4')).toEqual(['integer:3', 'binary:--', 'integer:4']);
    });
  });

  describe('§2.2 文字列', () => {
    it("' で囲み、中の ' は二重にして書く", () => {
      expect(kinds("'hello'")).toEqual(["string:'hello'"]);
      expect(kinds("''")).toEqual(["string:''"]);
      expect(kinds("'It''s'")).toEqual(["string:'It''s'"]);
    });

    it('改行を跨げる', () => {
      expect(kinds("'ab\ncd'")).toEqual(["string:'ab\ncd'"]);
    });

    it('閉じていない文字列は字句エラー', () => {
      const error = errorFrom("3 + 'abc");
      expect(error.line).toBe(1);
      expect(error.column).toBe(5);
    });
  });

  describe('§2.3 シンボル', () => {
    it('# に識別子・キーワードセレクタ・二項セレクタ・文字列を続ける', () => {
      expect(kinds('#foo')).toEqual(['symbol:#foo']);
      expect(kinds('#at:put:')).toEqual(['symbol:#at:put:']);
      expect(kinds('#+')).toEqual(['symbol:#+']);
      expect(kinds("#'hello world'")).toEqual(["symbol:#'hello world'"]);
    });

    it('# の後ろは綴りとして読むので、セル参照の形も書ける', () => {
      expect(kinds('#A1')).toEqual(['symbol:#A1']);
    });

    it('# の後ろに綴りが無ければ字句エラー', () => {
      expect(() => tokenize('#')).toThrow(LexicalError);
    });
  });

  describe('§2.4 リテラル配列', () => {
    it('#( で始まり ) で終わる', () => {
      expect(kinds('#(1 2)')).toEqual([
        'arrayStart:#(',
        'integer:1',
        'integer:2',
        'rightParen:)',
      ]);
      expect(kinds('#()')).toEqual(['arrayStart:#(', 'rightParen:)']);
    });

    it('隣接してトークンが変わるなら空白は要らない', () => {
      expect(kinds("#(1'foo')")).toEqual([
        'arrayStart:#(',
        'integer:1',
        "string:'foo'",
        'rightParen:)',
      ]);
      expect(kinds('#(12)')).toEqual(['arrayStart:#(', 'integer:12', 'rightParen:)']);
    });

    it('配列の中の - も §2.1 の付帯規則に従う', () => {
      expect(kinds('#(1-2)')).toEqual([
        'arrayStart:#(',
        'integer:1',
        'binary:-',
        'integer:2',
        'rightParen:)',
      ]);
      expect(kinds('#(-1)')).toEqual(['arrayStart:#(', 'integer:-1', 'rightParen:)']);
    });

    it('入れ子の配列は # を省ける', () => {
      expect(kinds('#(1 (2))')).toEqual([
        'arrayStart:#(',
        'integer:1',
        'leftParen:(',
        'integer:2',
        'rightParen:)',
        'rightParen:)',
      ]);
    });
  });

  describe('§4.3 範囲の糖衣', () => {
    it('セル参照を .. か : でつないだ形を 1 つのトークンにする', () => {
      expect(kinds('A1..B10')).toEqual(['range:A1..B10']);
      expect(kinds('A1:B10')).toEqual(['range:A1:B10']);
    });

    it('区切りの前後に空白もコメントも挟めない', () => {
      expect(kinds('A1 .. B10')).toEqual(['cell:A1', 'period:.', 'period:.', 'cell:B10']);
      expect(kinds('A1.. B10')).toEqual(['cell:A1', 'period:.', 'period:.', 'cell:B10']);
      expect(kinds('A1"c"..B10')).toEqual(['cell:A1', 'period:.', 'period:.', 'cell:B10']);
    });

    it('両辺はセル参照でなければ範囲にならない', () => {
      expect(kinds('A1..5')).toEqual(['cell:A1', 'period:.', 'period:.', 'integer:5']);
      expect(kinds('A1:foo')).toEqual(['cell:A1', 'colon::', 'identifier:foo']);
    });

    it('最長一致で切り出すので、範囲の範囲にはならない', () => {
      expect(kinds('A1..B2..C3')).toEqual([
        'range:A1..B2',
        'period:.',
        'period:.',
        'cell:C3',
      ]);
    });

    it('正準形は通常のメッセージ式のまま', () => {
      expect(kinds('A1 to: B10')).toEqual(['cell:A1', 'keyword:to:', 'cell:B10']);
      expect(kinds('A1 max:B1')).toEqual(['cell:A1', 'keyword:max:', 'cell:B1']);
    });
  });

  describe('§7 区切り記号', () => {
    it('マクロの文と返却の記号を切り出す', () => {
      expect(kinds('1. ^ 2')).toEqual(['integer:1', 'period:.', 'caret:^', 'integer:2']);
    });

    it('代入は := の 1 トークン', () => {
      expect(kinds('a := 1')).toEqual(['identifier:a', 'assign::=', 'integer:1']);
      expect(kinds('A1 := 1')).toEqual(['cell:A1', 'assign::=', 'integer:1']);
    });

    it('空白の無い a:=1 も代入として読む', () => {
      expect(kinds('a:=1')).toEqual(['identifier:a', 'assign::=', 'integer:1']);
    });

    it('ブロックの引数は : と識別子の並び', () => {
      expect(kinds('[:x | x]')).toEqual([
        'leftBracket:[',
        'colon::',
        'identifier:x',
        'binary:|',
        'identifier:x',
        'rightBracket:]',
      ]);
    });
  });

  describe('位置', () => {
    it('トークンに 1 始まりの行と列を持たせる', () => {
      expect(tokenize('3\n  + 4')).toEqual([
        { kind: 'integer', text: '3', line: 1, column: 1 },
        { kind: 'binary', text: '+', line: 2, column: 3 },
        { kind: 'integer', text: '4', line: 2, column: 5 },
      ]);
    });

    it('複数行の文字列を跨いだ後も行を数え続ける', () => {
      expect(tokenize("'a\nb' + 1").map((t) => [t.line, t.column])).toEqual([
        [1, 1],
        [2, 3],
        [2, 5],
      ]);
    });

    it('字句エラーの位置は問題の始まりを指す', () => {
      const error = errorFrom("1\n2 + 'abc");
      expect(error.line).toBe(2);
      expect(error.column).toBe(5);
    });
  });
});
