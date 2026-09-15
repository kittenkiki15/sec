import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './evaluate.ts';
import { printValue } from './value.ts';

/** 原文を評価し、§0.3 の表記にする。ゴールデンテストが見るのと同じ経路。 */
const evaluated = (source: string): string => printValue(evaluateFormula(source));

describe('evaluateFormula のリテラル', () => {
  it('整数を値にする', () => {
    expect(evaluateFormula('42')).toEqual({ kind: 'integer', value: 42n });
    expect(evaluated('0')).toBe('0');
    expect(evaluated('-5')).toBe('-5');
  });

  it('先頭の 0 は構文解析の段階で落ちている', () => {
    expect(evaluated('007')).toBe('7');
  });

  it('指数は仮数の種別を変えない（§2.1）', () => {
    expect(evaluateFormula('1e3')).toEqual({ kind: 'integer', value: 1000n });
    expect(evaluated('1.5e3')).toBe('1500.0');
    expect(evaluated('2e-3')).toBe('0.002');
  });

  it('小数を値にする', () => {
    expect(evaluateFormula('3.14')).toEqual({ kind: 'decimal', value: 3.14 });
  });

  it('文字列を値にする', () => {
    expect(evaluateFormula("'hello'")).toEqual({ kind: 'string', value: 'hello' });
    expect(evaluated("'It''s'")).toBe("'It''s'");
    expect(evaluated("''")).toBe("''");
  });

  it('シンボルを値にする', () => {
    expect(evaluateFormula('#foo')).toEqual({ kind: 'symbol', value: 'foo' });
    expect(evaluated('#at:put:')).toBe('#at:put:');
    expect(evaluated("#'hello world'")).toBe("#'hello world'");
  });

  it('真偽値と nil を値にする', () => {
    expect(evaluateFormula('true')).toEqual({ kind: 'boolean', value: true });
    expect(evaluated('false')).toBe('false');
    expect(evaluated('nil')).toBe('nil');
  });

  it('リテラル配列を値にする', () => {
    expect(evaluated('#(1 2 3)')).toBe('#(1 2 3)');
    expect(evaluated('#()')).toBe('#()');
    expect(evaluated("#(1 'two' #three true nil)")).toBe("#(1 'two' #three true nil)");
  });

  it('裸の識別子は配列の中ではシンボルになる（§2.4）', () => {
    expect(evaluated('#(foo bar)')).toBe('#(#foo #bar)');
  });

  it('入れ子のリテラル配列を値にする', () => {
    expect(evaluated('#(1 (2 3))')).toBe('#(1 #(2 3))');
  });
});

describe('evaluateFormula のエラー', () => {
  // 要件 F-8-1: エラーは値である。例外にすると評価の途中で制御が飛び、
  // §6.0 の伝播順序を値の受け渡しで表せなくなる。
  it('構文エラーを例外ではなく #Syntax の値にする', () => {
    expect(evaluateFormula('3 +')).toEqual({ kind: 'error', error: 'Syntax' });
    expect(evaluated('()')).toBe('#Syntax');
    expect(evaluated('(3 + 4')).toBe('#Syntax');
  });

  it('字句エラーも #Syntax の値にする', () => {
    // 閉じていない文字列・コメントは字句の段階で落ちる。
    expect(evaluated("'abc")).toBe('#Syntax');
    expect(evaluated('3 + 4 "閉じていない')).toBe('#Syntax');
  });

  it('数式が拒む構文も #Syntax（§7.3）', () => {
    expect(evaluated('a := 1')).toBe('#Syntax');
    expect(evaluated('^ 3')).toBe('#Syntax');
  });

  it('倍精度に収まらない小数のリテラルは #Overflow（ADR-0013）', () => {
    // 構文エラーではないので、構文解析器が木に載せたものをそのまま値にする。
    expect(evaluateFormula('1.0e400')).toEqual({ kind: 'error', error: 'Overflow' });
  });

  it('空の原文は #Syntax', () => {
    expect(evaluated('')).toBe('#Syntax');
  });
});

describe('evaluateFormula のまだ評価できないもの', () => {
  // 保留のケース（!pending）はここで例外になる。黙って別の値を返すと、
  // ゴールデンテストが「たまたま期待値と一致した」ことを検出できなくなる。
  it('セル参照は例外にする', () => {
    expect(() => evaluateFormula('A1')).toThrow(/未実装/);
  });

  it('裸の識別子は例外にする', () => {
    expect(() => evaluateFormula('foo')).toThrow(/未実装/);
  });
});

describe('evaluateFormula のメッセージ送信', () => {
  it('単項メッセージを左から右へ送る（§3.2）', () => {
    expect(evaluated('5 abs')).toBe('5');
    expect(evaluated('3 negated abs')).toBe('3');
    expect(evaluated('2 squared squared')).toBe('16');
  });

  it('二項メッセージを送る（§3.3）', () => {
    expect(evaluated('3 + 4')).toBe('7');
    expect(evaluated('10 - 4')).toBe('6');
    expect(evaluated('3 > 5')).toBe('false');
    expect(evaluated('3 = 3')).toBe('true');
  });

  it('複数のキーワードは連結して 1 つのセレクタになる（§3.4）', () => {
    expect(evaluated('3 between: 1 and: 5')).toBe('true');
    // max:min: というセレクタは無い。1 回の送信なので #DoesNotUnderstand になる。
    expect(evaluated('3 max: 4 min: 2')).toBe('#DoesNotUnderstand');
    expect(evaluated('(3 max: 4) min: 2')).toBe('2');
  });

  it('受け手がセレクタを持たなければ #DoesNotUnderstand（§3.7）', () => {
    expect(evaluated('3 foo')).toBe('#DoesNotUnderstand');
    expect(evaluated('3 foo: 4')).toBe('#DoesNotUnderstand');
    // 基数表記は本仕様に無いので、16 に rFF を送る式として読まれる（§2.1）。
    expect(evaluated('16rFF')).toBe('#DoesNotUnderstand');
  });
});

describe('evaluateFormula の優先順位（§3.5）', () => {
  it('二項メッセージに優先順位は無く、左から右へ評価する', () => {
    expect(evaluated('3 + 4 * 2')).toBe('14');
    expect(evaluated('2 * 3 + 4')).toBe('10');
    expect(evaluated('1 + 2 > 2')).toBe('true');
  });

  it('括弧は順位を無視して先に評価される', () => {
    expect(evaluated('3 + (4 * 2)')).toBe('11');
    expect(evaluated('(1 + 2) * (3 + 4)')).toBe('21');
  });

  it('単項は二項より、二項はキーワードより強い', () => {
    expect(evaluated('2 * 3 squared')).toBe('18');
    expect(evaluated('3 max: 1 + 4')).toBe('5');
    expect(evaluated('2 max: 3 + 4 squared')).toBe('19');
    expect(evaluated('1 + 2 * 3 squared')).toBe('27');
  });
});

describe('evaluateFormula の数（§6.1）', () => {
  it('整数どうしは任意精度のまま求める', () => {
    expect(evaluated('9007199254740993 + 1')).toBe('9007199254740994');
  });

  it('整数と小数が混ざれば小数になる（伝染）', () => {
    expect(evaluated('1 + 2.0')).toBe('3.0');
    expect(evaluated('0.1 + 0.2')).toBe('0.30000000000000004');
    // 変換できる範囲で桁が落ちるのはエラーではない。
    expect(evaluated('9007199254740993 + 0.0')).toBe('9007199254740992.0');
  });

  it('/ が整数を返すのは両方が整数で割り切れるときだけ', () => {
    expect(evaluated('6 / 3')).toBe('2');
    expect(evaluated('7 / 2')).toBe('3.5');
    expect(evaluated('6.0 / 3')).toBe('2.0');
  });

  it('除数が 0 なら変換より先に #DivideByZero（§6.0 の検査の順序）', () => {
    expect(evaluated('1 / 0')).toBe('#DivideByZero');
    expect(evaluated('1e400 / 0.0')).toBe('#DivideByZero');
  });

  it('小数として求める値が表せなければ #Overflow', () => {
    expect(evaluated('1e400 / 3')).toBe('#Overflow');
    expect(evaluated('1e400 + 0.0')).toBe('#Overflow');
    expect(evaluated('1.0e308 * 10')).toBe('#Overflow');
    // 整数のままなら範囲の制限は無い。
    expect(evaluated('1e400 / 1e399')).toBe('10');
  });

  it('小さすぎて表せない値は 0.0 に丸める。#Overflow にはしない', () => {
    expect(evaluated('1.0e-300 * 1.0e-100')).toBe('0.0');
  });

  it('比較は大きさを比べるだけなので #Overflow にならない', () => {
    expect(evaluated('1e400 > 1.0')).toBe('true');
    expect(evaluated('1.0 min: 1e400')).toBe('1.0');
  });

  it('整数と小数の比較は倍精度へ落とさずに行う', () => {
    // 受け手を倍精度にすると 9007199254740992 に丸まり、偽になってしまう。
    expect(evaluated('9007199254740993 > 9007199254740992.0')).toBe('true');
    expect(evaluated('1 = 1.0')).toBe('true');
  });

  it('min: と max: は値が等しければ引数を返す', () => {
    expect(evaluated('1 min: 1.0')).toBe('1.0');
    expect(evaluated('1.0 max: 1')).toBe('1');
    expect(evaluated('(1 min: 1.0) + 0')).toBe('1.0');
  });

  it('between:and: は境界を含み、逆向きの区間は常に false', () => {
    expect(evaluated('1 between: 1 and: 5')).toBe('true');
    expect(evaluated('3 between: 5 and: 1')).toBe('false');
    expect(evaluated('7 between: 1 and: 5')).toBe('false');
  });

  it('= は型が違ってもエラーにならない。大小は型が揃っていないと決まらない', () => {
    expect(evaluated("1 = 'abc'")).toBe('false');
    expect(evaluated('1 = nil')).toBe('false');
    expect(evaluated("1 > 'abc'")).toBe('#TypeError');
  });

  it('#DoesNotUnderstand は受け手、#TypeError は引数（§6.0）', () => {
    expect(evaluated('nil + 1')).toBe('#DoesNotUnderstand');
    expect(evaluated('1 + nil')).toBe('#TypeError');
  });
});

describe('evaluateFormula の商と剰余（§6.1）', () => {
  it('// は床除算で、商は負の無限大の側へ丸める', () => {
    expect(evaluated('7 // 2')).toBe('3');
    expect(evaluated('-7 // 2')).toBe('-4');
    expect(evaluated('7 // -2')).toBe('-4');
  });

  it('剰余の符号は除数に合わせる', () => {
    expect(evaluated('7 \\\\ 2')).toBe('1');
    expect(evaluated('-7 \\\\ 2')).toBe('1');
    expect(evaluated('7 \\\\ -2')).toBe('-1');
  });

  it('整数を返すのは // だけで、\\\\ は小数を返しうる', () => {
    expect(evaluated('7.5 // 2')).toBe('3');
    expect(evaluated('7.5 \\\\ 2')).toBe('1.5');
  });

  it('除数が 0 なら #DivideByZero。変換より先に判定する', () => {
    expect(evaluated('7 // 0')).toBe('#DivideByZero');
    expect(evaluated('7 \\\\ 0')).toBe('#DivideByZero');
    expect(evaluated('1e400 // 0.0')).toBe('#DivideByZero');
    expect(evaluated('1e400 \\\\ 0.0')).toBe('#DivideByZero');
  });

  it('小数が混ざれば商を小数で求めるので、範囲の制限がかかる', () => {
    expect(evaluated('1.0e308 // 1.0e-300')).toBe('#Overflow');
    // 剰余は同じ商を経由するので、同じ条件で #Overflow になる。
    expect(evaluated('1.0e308 \\\\ 1.0e-300')).toBe('#Overflow');
  });

  it('整数どうしなら整数演算のままなので、どれだけ大きくても通る', () => {
    expect(evaluated('1e400 // 1e399')).toBe('10');
    expect(evaluated('(1e400 * 1e400) // 1e800')).toBe('1');
  });
});

describe('evaluateFormula の sqrt / rounded / truncated（§6.1）', () => {
  it('sqrt は常に小数を返す', () => {
    expect(evaluated('4 sqrt')).toBe('2.0');
    expect(evaluated('0 sqrt')).toBe('0.0');
    expect(evaluated('2 sqrt')).toBe('1.4142135623730951');
  });

  it('負の数の平方根は実数の範囲に無いので #Overflow（ADR-0013）', () => {
    expect(evaluated('-1 sqrt')).toBe('#Overflow');
  });

  it('受け手の変換が演算より先に起きる', () => {
    // 結果の 1e200 は表せるが、受け手を小数にできないので #Overflow。
    expect(evaluated('1e400 sqrt')).toBe('#Overflow');
  });

  it('rounded は端数がちょうど半分なら大きい側へ', () => {
    expect(evaluated('3.7 rounded')).toBe('4');
    expect(evaluated('2.5 rounded')).toBe('3');
    expect(evaluated('-2.5 rounded')).toBe('-2');
    expect(evaluated('-3.7 rounded')).toBe('-4');
  });

  it('truncated は 0 の側へ落とす', () => {
    expect(evaluated('3.7 truncated')).toBe('3');
    expect(evaluated('-3.7 truncated')).toBe('-3');
  });

  it('どちらも常に整数を返す。整数に送っても整数のまま', () => {
    expect(evaluated('3 rounded')).toBe('3');
    expect(evaluated('3 truncated')).toBe('3');
  });
});

describe('evaluateFormula の比較の残り（§6.1）', () => {
  it('< と <= を送る', () => {
    expect(evaluated('3 < 4')).toBe('true');
    expect(evaluated('4 < 3')).toBe('false');
    expect(evaluated('3 <= 3')).toBe('true');
    expect(evaluated('1.0 < 1e400')).toBe('true');
  });

  it('~= は = の否定で、型が違ってもエラーにならない', () => {
    expect(evaluated('3 ~= 4')).toBe('true');
    expect(evaluated('3 ~= 3')).toBe('false');
    expect(evaluated("1 ~= 'abc'")).toBe('true');
  });

  it('大小は型が揃っていないと決まらない', () => {
    expect(evaluated("1 < 'abc'")).toBe('#TypeError');
  });
});

describe('evaluateFormula のエラーの伝播順序（§6.0、ADR-0011）', () => {
  it('受け手を引数より先に評価する', () => {
    expect(evaluated('(3 foo) + (1 / 0)')).toBe('#DoesNotUnderstand');
    expect(evaluated('(1 / 0) + (3 foo)')).toBe('#DivideByZero');
  });

  it('引数は左から右へ評価する', () => {
    expect(evaluated('3 between: (1 / 0) and: (3 foo)')).toBe('#DivideByZero');
    expect(evaluated('3 between: (3 foo) and: (1 / 0)')).toBe('#DoesNotUnderstand');
  });

  it('引数は送信より先に評価される', () => {
    // セレクタを理解しないと分かるのは送信のときなので、引数のエラーの方が先に出る。
    expect(evaluated('3 foo: (1 / 0)')).toBe('#DivideByZero');
    expect(evaluated('3 foo: 1')).toBe('#DoesNotUnderstand');
  });

  it('二項は左から右なので、右端まで進まないことがある', () => {
    expect(evaluated('1 + (3 foo) + (1 / 0)')).toBe('#DoesNotUnderstand');
  });

  it('エラーはメッセージを受け取らない', () => {
    // エラーが「セレクタを理解しない値」に変わるわけではない。
    expect(evaluated('(1 / 0) abs')).toBe('#DivideByZero');
    expect(evaluated('(1 / 0) abs squared')).toBe('#DivideByZero');
  });

  it('構文エラーは実行時のエラーより先に出る', () => {
    expect(evaluated('(1 / 0) +')).toBe('#Syntax');
    expect(evaluated('(1 / 0) max:')).toBe('#Syntax');
  });
});

describe('evaluateFormula のブロックと条件式（§5）', () => {
  it('ブロックは作るだけでは本体を評価しない', () => {
    expect(evaluated('[1 / 0]')).toBe('aBlock');
  });

  it('value を送って初めて本体を評価する', () => {
    expect(evaluated('[3 + 4] value')).toBe('7');
    expect(evaluated('[1 / 0] value')).toBe('#DivideByZero');
  });

  it('引数の数が合わなければ #TypeError（§5.1）', () => {
    expect(evaluated('[:x | x] value')).toBe('#TypeError');
  });

  it('選ばれなかった側のブロックは評価されない（§5.2）', () => {
    expect(evaluated('true ifTrue: [1] ifFalse: [1 / 0]')).toBe('1');
    expect(evaluated('false ifTrue: [1 / 0] ifFalse: [2]')).toBe('2');
  });

  it('受け手がエラーなら、どちらのブロックも評価されない', () => {
    expect(evaluated('(1 / 0) ifTrue: [1] ifFalse: [2]')).toBe('#DivideByZero');
  });

  it('条件式の引数はブロックでなければならない（要件 F-2-9）', () => {
    expect(evaluated('true ifTrue: 1 ifFalse: [2]')).toBe('#TypeError');
  });

  it('受け手が真偽値でなければ #DoesNotUnderstand（§5.2）', () => {
    expect(evaluated('3 ifTrue: [1] ifFalse: [2]')).toBe('#DoesNotUnderstand');
    expect(evaluated('nil ifTrue: [1] ifFalse: [2]')).toBe('#DoesNotUnderstand');
  });
});

describe('evaluateFormula の実行上限', () => {
  /** `#(` を重ねた入力。入れ子の深さがそのまま再帰の深さになる。 */
  const nested = (depth: number): string => '#('.repeat(depth) + ')'.repeat(depth);

  // 深い入れ子は、構文解析器と評価器のどちらの再帰も尽きさせうる。どちらで尽きても
  // 仕様外の例外（RangeError）を漏らさず、#Timeout の値にする（§7.8）。
  // **どの深さで尽きるかはスタックの大きさ次第なので、境界そのものは固定しない。**
  it('再帰が尽きる深さでは #Timeout を値として返す', () => {
    expect(evaluateFormula(nested(100000))).toEqual({ kind: 'error', error: 'Timeout' });
  });

  it('例外を呼び出し元へ漏らさない', () => {
    expect(() => evaluateFormula(nested(100000))).not.toThrow();
  });

  it('上限に達しない深さはそのまま評価する', () => {
    expect(evaluated(nested(100))).toBe(nested(100));
  });
});
