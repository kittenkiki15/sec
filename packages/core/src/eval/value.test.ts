import { describe, expect, it } from 'vitest';
import { printValue, type Value } from './value.ts';

const integer = (value: bigint): Value => ({ kind: 'integer', value });
const decimal = (value: number): Value => ({ kind: 'decimal', value });
const string = (value: string): Value => ({ kind: 'string', value });
const symbol = (value: string): Value => ({ kind: 'symbol', value });
const array = (...elements: Value[]): Value => ({ kind: 'array', elements });

describe('printValue の整数', () => {
  it('小数点を付けない', () => {
    expect(printValue(integer(42n))).toBe('42');
    expect(printValue(integer(0n))).toBe('0');
    expect(printValue(integer(-5n))).toBe('-5');
  });

  it('桁数に上限が無い（ADR-0012）', () => {
    expect(printValue(integer(10n ** 30n))).toBe('1000000000000000000000000000000');
  });
});

describe('printValue の小数', () => {
  it('小数点を必ず付ける', () => {
    expect(printValue(decimal(3.14))).toBe('3.14');
    expect(printValue(decimal(0.5))).toBe('0.5');
    expect(printValue(decimal(1500))).toBe('1500.0');
    expect(printValue(decimal(2))).toBe('2.0');
  });

  it('ゼロは 0.0。負のゼロも 0.0（§0.3）', () => {
    expect(printValue(decimal(0))).toBe('0.0');
    expect(printValue(decimal(-0))).toBe('0.0');
  });

  it('負の小数', () => {
    expect(printValue(decimal(-3.14))).toBe('-3.14');
  });

  // ADR-0017 が挙げている、通常表記のまま変わらないことを確かめた値。
  it('倍精度の丸めが見える値をそのまま書く', () => {
    expect(printValue(decimal(0.30000000000000004))).toBe('0.30000000000000004');
    expect(printValue(decimal(2.3333333333333335))).toBe('2.3333333333333335');
    expect(printValue(decimal(9007199254740992))).toBe('9007199254740992.0');
  });
});

describe('printValue の指数表記（ADR-0017）', () => {
  it('絶対値が 1e21 以上なら指数表記', () => {
    expect(printValue(decimal(1e21))).toBe('1.0e21');
    expect(printValue(decimal(1.5e22))).toBe('1.5e22');
    expect(printValue(decimal(-1e21))).toBe('-1.0e21');
  });

  it('1e21 の手前は通常表記', () => {
    expect(printValue(decimal(1e20))).toBe('100000000000000000000.0');
  });

  it('絶対値が 1e-6 未満なら指数表記', () => {
    expect(printValue(decimal(1e-7))).toBe('1.0e-7');
    expect(printValue(decimal(1e-310))).toBe('1.0e-310');
  });

  it('1e-6 ちょうどは通常表記', () => {
    expect(printValue(decimal(0.000001))).toBe('0.000001');
  });

  it('仮数に小数点を必ず付け、正の指数に + を付けない', () => {
    // 1e21 と書くと §2.1 では整数リテラルの綴りでもあり、表記から型が読めなくなる。
    expect(printValue(decimal(1e21))).not.toBe('1e21');
    expect(printValue(decimal(1e21))).not.toContain('+');
  });
});

describe('printValue の文字列', () => {
  it("' で囲む", () => {
    expect(printValue(string('hello'))).toBe("'hello'");
    expect(printValue(string(''))).toBe("''");
  });

  it("内部の ' を二重にする", () => {
    expect(printValue(string("It's"))).toBe("'It''s'");
    expect(printValue(string("''"))).toBe("''''''");
  });

  it('改行をそのまま書く', () => {
    expect(printValue(string('ab\ncd'))).toBe("'ab\ncd'");
  });

  it('エスケープは無い。\\n は 2 文字（§2.2）', () => {
    expect(printValue(string('\\n'))).toBe("'\\n'");
  });
});

describe('printValue のシンボル', () => {
  it('識別子・キーワードセレクタ・二項セレクタはそのまま書く', () => {
    expect(printValue(symbol('foo'))).toBe('#foo');
    expect(printValue(symbol('at:put:'))).toBe('#at:put:');
    expect(printValue(symbol('+'))).toBe('#+');
    expect(printValue(symbol('>='))).toBe('#>=');
  });

  it('セル参照の形も綴りとして読むのでそのまま（§2.3）', () => {
    expect(printValue(symbol('A1'))).toBe('#A1');
  });

  it('識別子にできない綴りは引用符で囲む', () => {
    expect(printValue(symbol('hello world'))).toBe("#'hello world'");
    expect(printValue(symbol(''))).toBe("#''");
    expect(printValue(symbol('1abc'))).toBe("#'1abc'");
  });

  it("引用符で囲むときは内部の ' を二重にする", () => {
    expect(printValue(symbol("it's"))).toBe("#'it''s'");
  });
});

describe('printValue の真偽値と nil', () => {
  it('そのまま書く', () => {
    expect(printValue({ kind: 'boolean', value: true })).toBe('true');
    expect(printValue({ kind: 'boolean', value: false })).toBe('false');
    expect(printValue({ kind: 'nil' })).toBe('nil');
  });
});

describe('printValue のリテラル配列', () => {
  it('要素を空白 1 つで区切る', () => {
    expect(printValue(array(integer(1n), integer(2n), integer(3n)))).toBe('#(1 2 3)');
  });

  it('空の配列', () => {
    expect(printValue(array())).toBe('#()');
  });

  it('要素の種別が混ざってもそれぞれの表記に従う', () => {
    expect(
      printValue(
        array(
          integer(1n),
          string('two'),
          symbol('three'),
          { kind: 'boolean', value: true },
          {
            kind: 'nil',
          },
        ),
      ),
    ).toBe("#(1 'two' #three true nil)");
  });

  it('入れ子の配列にも # を付ける', () => {
    expect(printValue(array(integer(1n), array(integer(2n), integer(3n))))).toBe('#(1 #(2 3))');
  });
});

describe('printValue のエラー', () => {
  it('種別のシンボルだけを書く（§0.3）', () => {
    expect(printValue({ kind: 'error', error: 'Syntax' })).toBe('#Syntax');
    expect(printValue({ kind: 'error', error: 'DoesNotUnderstand' })).toBe('#DoesNotUnderstand');
    expect(printValue({ kind: 'error', error: 'Overflow' })).toBe('#Overflow');
  });

  it('エラーを要素に持つ配列は現れないが、表記は種別に従う', () => {
    expect(printValue(array({ kind: 'error', error: 'Ref' }))).toBe('#(#Ref)');
  });
});

describe('printValue のブロック', () => {
  // §5.1: 引数の数も本体も表記しない。本体の原文をそのまま書くと、空白の入れ方を
  // 変えただけでゴールデンテストが落ちる（エラーの表記に文言を含めない理由と同じ）。
  it('引数の数によらず aBlock と書く', () => {
    const body = { temporaries: [], statements: [{ kind: 'integer', value: 1n } as const] };
    const environment = new Map();
    expect(printValue({ kind: 'block', parameters: [], body, environment })).toBe('aBlock');
    expect(printValue({ kind: 'block', parameters: ['x', 'y'], body, environment })).toBe('aBlock');
  });
});
