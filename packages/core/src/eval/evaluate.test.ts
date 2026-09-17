import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './evaluate.ts';
import { printValue, type Value } from './value.ts';

/** 原文を評価して値だけを取る。診断を見ないケースはこちらを使う。 */
const evaluatedValue = (source: string): Value => evaluateFormula(source).value;

/** 原文を評価し、§0.3 の表記にする。ゴールデンテストが見るのと同じ経路。 */
const evaluated = (source: string): string => printValue(evaluatedValue(source));

describe('evaluateFormula のリテラル', () => {
  it('整数を値にする', () => {
    expect(evaluatedValue('42')).toEqual({ kind: 'integer', value: 42n });
    expect(evaluated('0')).toBe('0');
    expect(evaluated('-5')).toBe('-5');
  });

  it('先頭の 0 は構文解析の段階で落ちている', () => {
    expect(evaluated('007')).toBe('7');
  });

  it('指数は仮数の種別を変えない（§2.1）', () => {
    expect(evaluatedValue('1e3')).toEqual({ kind: 'integer', value: 1000n });
    expect(evaluated('1.5e3')).toBe('1500.0');
    expect(evaluated('2e-3')).toBe('0.002');
  });

  it('小数を値にする', () => {
    expect(evaluatedValue('3.14')).toEqual({ kind: 'decimal', value: 3.14 });
  });

  it('文字列を値にする', () => {
    expect(evaluatedValue("'hello'")).toEqual({ kind: 'string', value: 'hello' });
    expect(evaluated("'It''s'")).toBe("'It''s'");
    expect(evaluated("''")).toBe("''");
  });

  it('シンボルを値にする', () => {
    expect(evaluatedValue('#foo')).toEqual({ kind: 'symbol', value: 'foo' });
    expect(evaluated('#at:put:')).toBe('#at:put:');
    expect(evaluated("#'hello world'")).toBe("#'hello world'");
  });

  it('真偽値と nil を値にする', () => {
    expect(evaluatedValue('true')).toEqual({ kind: 'boolean', value: true });
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
    expect(evaluatedValue('3 +')).toEqual({ kind: 'error', error: 'Syntax' });
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
    expect(evaluatedValue('1.0e400')).toEqual({ kind: 'error', error: 'Overflow' });
  });

  it('空の原文は #Syntax', () => {
    expect(evaluated('')).toBe('#Syntax');
  });
});

describe('evaluateFormula のセル参照（§4.2）', () => {
  // 値の側はゴールデンテスト（references.txt）が網羅している。ここに置くのは、
  // **シートを渡さずに評価したとき**の振る舞いと、まだ実装の無い行き先である。
  it('シートを渡さなければ、どのセルも空として扱う', () => {
    expect(evaluated('A1')).toBe('nil');
    expect(evaluated('A1 value')).toBe('nil');
  });

  it('解決できない参照は #Ref（§4.2）', () => {
    expect(evaluated('A0')).toBe('#Ref');
    expect(evaluated('A000')).toBe('#Ref');
  });

  it('どこにも束縛されていない識別子も #Ref', () => {
    expect(evaluated('foo')).toBe('#Ref');
    expect(evaluated('Abc123')).toBe('#Ref');
  });

  it('ブロックの引数は識別子として解決できる（§5.1）', () => {
    expect(evaluated('[:x | x] value: 1')).toBe('1');
  });
});

describe('evaluateFormula の範囲（§4.3）', () => {
  // 矩形の正規化と表記はゴールデンテスト（ranges.txt）が網羅している。ここに置くのは
  // **値としての形**と、シートを渡さなくても作れること（範囲はセルの値を読まない）である。
  it('Cell>>to: が範囲を返す。両端に値が入っていなくてもよい', () => {
    expect(evaluatedValue('A1 to: B2')).toEqual({
      kind: 'range',
      topLeft: { column: 'A', row: 1n },
      bottomRight: { column: 'B', row: 2n },
    });
  });

  it('糖衣は構文解析の時点で to: へ脱糖するので、同じ値になる', () => {
    expect(evaluatedValue('A1..B2')).toEqual(evaluatedValue('A1 to: B2'));
    expect(evaluatedValue('A1:B2')).toEqual(evaluatedValue('A1 to: B2'));
  });

  // 解決できない番地は Cell にならない（§4.2）ので、範囲を作る前に打ち切られる。
  it('解決できない番地からは範囲を作れない', () => {
    expect(evaluated('A0 to: B2')).toBe('#Ref');
    expect(evaluated('A1 to: B0')).toBe('#Ref');
  });

  it('引数がセルでなければ #TypeError（§6.3 の Cell の表）', () => {
    expect(evaluated('A1 to: 5')).toBe('#TypeError');
    expect(evaluated("A1 to: 'x'")).toBe('#TypeError');
    expect(evaluated('A1 to: nil')).toBe('#TypeError');
  });

  it('範囲は to: を理解しない。範囲の範囲は作れない', () => {
    expect(evaluated('(A1 to: A2) to: A3')).toBe('#DoesNotUnderstand');
  });

  it('同じ矩形かどうかで比べる。要素の値は見ない（§6.3）', () => {
    expect(evaluated('A1..B2 = (B2..A1)')).toBe('true');
    expect(evaluated('A1..B2 = (A1..B3)')).toBe('false');
    expect(evaluated('A1..B2 ~= (A1..B3)')).toBe('true');
    expect(evaluated('A1..B2 = 3')).toBe('false');
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

describe('evaluateFormula のブロックの引数（§5.1）', () => {
  it('value: と value:value: で引数を束ねる', () => {
    expect(evaluated('[:x | x * 2] value: 3')).toBe('6');
    expect(evaluated('[:x :y | x - y] value: 10 value: 4')).toBe('6');
  });

  it('引数は本体の中で識別子として解決できる', () => {
    expect(evaluated('[:each | each + 1] value: 10')).toBe('11');
  });

  it('引数の数が合わなければ #TypeError（§5.1）', () => {
    expect(evaluated('[:x | x] value')).toBe('#TypeError');
    expect(evaluated('[3] value: 1')).toBe('#TypeError');
    expect(evaluated('[:x :y | x] value: 1')).toBe('#TypeError');
    expect(evaluated('[:x | x] value: 1 value: 2')).toBe('#TypeError');
  });

  // 条件式もブロックを引数を渡さずに評価するので、同じ規則が当たる。
  // §5.2 は受け手と引数の型しか定めていないが、引数の数の検査は呼び出しの側にある。
  it('条件式が評価するブロックにも引数の数の検査が当たる', () => {
    expect(evaluated('true ifTrue: [:x | x]')).toBe('#TypeError');
    expect(evaluated('nil ifNil: [:x | x]')).toBe('#TypeError');
    expect(evaluated('true ifTrue: [:x | x] ifFalse: [2]')).toBe('#TypeError');
  });

  // 引数の型（ブロックかどうか）は引数そのものの性質で、評価せずに見えるので常に検査する。
  // 引数の数が合うかは、ブロックを評価するときに初めて問題になる（§5.2）。
  it('選ばれなかった側は引数の数を検査しない', () => {
    expect(evaluated('false ifTrue: [:x | x]')).toBe('nil');
    expect(evaluated('true ifFalse: [:x | x]')).toBe('nil');
    expect(evaluated('true ifTrue: [1] ifFalse: [:x | x]')).toBe('1');
    expect(evaluated('false and: [:x | x]')).toBe('false');
    expect(evaluated('1 ifNil: [:x | x]')).toBe('1');
    // 型の方は短絡しても検査する。
    expect(evaluated('false and: 1')).toBe('#TypeError');
  });

  it('引数は送信の前に評価され、エラーならブロックは評価されない（§3.6）', () => {
    expect(evaluated('[:x | 1] value: 1 / 0')).toBe('#DivideByZero');
  });

  it('ブロックは作られた時点の環境を捕まえる', () => {
    expect(evaluated('[:x | [:y | x + y] value: 1] value: 2')).toBe('3');
    // 捕まえた環境は、作った送信が終わった後も生きている。
    expect(evaluated('([:x | [x + 1]] value: 2) value')).toBe('3');
  });

  it('外側の引数を内側から見た上で、内側の引数が優先されることはない（影は #Syntax）', () => {
    expect(evaluated('[:x | [:x | x] value: 1] value: 2')).toBe('#Syntax');
    expect(evaluated('[:x :x | x] value: 1 value: 2')).toBe('#Syntax');
  });

  it('ブロックの中でも、束縛されていない識別子は #Ref（§4.2）', () => {
    expect(evaluated('[:x | y] value: 1')).toBe('#Ref');
  });
});

describe('evaluateFormula の条件式の残り（§5.2）', () => {
  it('ifTrue: と ifFalse: は選ばれなければ nil を返す', () => {
    expect(evaluated('true ifTrue: [1]')).toBe('1');
    expect(evaluated('false ifTrue: [1]')).toBe('nil');
    expect(evaluated('false ifFalse: [2]')).toBe('2');
    expect(evaluated('true ifFalse: [2]')).toBe('nil');
  });

  // 順序を入れ替えた形は別のセレクタなので、遅延評価も別に固定する必要がある（§5.2）。
  it('ifFalse:ifTrue: も理解し、選ばれなかった側は評価されない', () => {
    expect(evaluated('true ifFalse: [1 / 0] ifTrue: [2]')).toBe('2');
    expect(evaluated('false ifFalse: [1] ifTrue: [1 / 0]')).toBe('1');
  });

  it('選ばれなかった側は評価されない（セレクタごとに固定する）', () => {
    expect(evaluated('false ifTrue: [1 / 0]')).toBe('nil');
    expect(evaluated('true ifFalse: [1 / 0]')).toBe('nil');
    expect(evaluated('true ifTrue: [1 / 0]')).toBe('#DivideByZero');
  });

  it('引数はブロックでなければ #TypeError（要件 F-2-9）', () => {
    expect(evaluated('true ifTrue: 1')).toBe('#TypeError');
    expect(evaluated('false ifTrue: 1')).toBe('#TypeError');
    expect(evaluated('true ifFalse: 1')).toBe('#TypeError');
    expect(evaluated('true ifTrue: [1] ifFalse: 2')).toBe('#TypeError');
    expect(evaluated('true ifFalse: 1 ifTrue: [2]')).toBe('#TypeError');
  });

  it('受け手が真偽値でなければ #DoesNotUnderstand', () => {
    expect(evaluated('3 ifTrue: [1]')).toBe('#DoesNotUnderstand');
    expect(evaluated('nil ifTrue: [1]')).toBe('#DoesNotUnderstand');
    expect(evaluated("'abc' ifFalse: [1]")).toBe('#DoesNotUnderstand');
  });

  // 空になりうるものは String（§6.2）と Array / Interval（§6.3）。
  // Array の残りのセレクタは段階 6 だが、ifEmpty: は条件式として §5.2 の表にある。
  it('Array も ifEmpty: を理解する（§5.2）', () => {
    expect(evaluated("#() ifEmpty: ['空']")).toBe("'空'");
    expect(evaluated("#(1 2) ifEmpty: ['空']")).toBe('#(1 2)');
    // 受け手が空でなければ引数は評価されない。
    expect(evaluated('#(1 2) ifEmpty: [1 / 0]')).toBe('#(1 2)');
    expect(evaluated('#() ifEmpty: 1')).toBe('#TypeError');
  });
});

describe('evaluateFormula の実行上限', () => {
  /** `#(` を重ねた入力。入れ子の深さがそのまま再帰の深さになる。 */
  const nested = (depth: number): string => '#('.repeat(depth) + ')'.repeat(depth);

  // 深い入れ子は、構文解析器と評価器のどちらの再帰も尽きさせうる。どちらで尽きても
  // 仕様外の例外（RangeError）を漏らさず、#Timeout の値にする（§7.8）。
  // **どの深さで尽きるかはスタックの大きさ次第なので、境界そのものは固定しない。**
  it('再帰が尽きる深さでは #Timeout を値として返す', () => {
    expect(evaluatedValue(nested(100000))).toEqual({ kind: 'error', error: 'Timeout' });
  });

  it('例外を呼び出し元へ漏らさない', () => {
    expect(() => evaluateFormula(nested(100000))).not.toThrow();
  });

  it('上限に達しない深さはそのまま評価する', () => {
    expect(evaluated(nested(100))).toBe(nested(100));
  });

  // 区間は個数を先に決めるので、要素を並べずに極端に大きい区間を作れる（ADR-0016）。
  // **列挙にはステップ数の上限が当たる**（要件 N-5、§7.8、CLAUDE.md 規約 4）。
  it('極端に大きい区間の列挙は #Timeout になる', () => {
    expect(evaluated('(1 to: 1e400) sum')).toBe('#Timeout');
    expect(evaluated('(1 to: 1e400) collect: [:x | x]')).toBe('#Timeout');
    expect(evaluated('(1 to: 1e400) detect: [:x | x > 1] ifNone: [0]')).toBe('#Timeout');
    expect(evaluated('(1 to: 1e400) sorted: [:a :b | a < b]')).toBe('#Timeout');
  });

  it('上限が当たるのは列挙だけで、個数と位置で決まるものには当たらない', () => {
    expect(evaluated('(1 to: 1e400) size')).toBe(`1${'0'.repeat(400)}`);
    expect(evaluated('(1 to: 1e400) first')).toBe('1');
    expect(evaluated('(1 to: 1e400) isEmpty')).toBe('false');
  });

  it('上限に達しない大きさの列挙はそのまま評価する', () => {
    expect(evaluated('(1 to: 1000) sum')).toBe('500500');
    expect(evaluated('((1 to: 1000) collect: [:x | x * 2]) size')).toBe('1000');
    expect(evaluated('((1 to: 1000) collect: [:x | x * 2]) first')).toBe('2');
    expect(evaluated('((1 to: 1000) collect: [:x | x * 2]) last')).toBe('2000');
  });

  // **予算切れは値ではなく打ち切りである。** リテラル配列の要素を評価している途中で
  // 尽きたとき、#Timeout を要素に混ぜると「打ち切られた」ことが式の値から読み取れない。
  // 要素の #Overflow（#(1.0e400)）とは違い、これは要素の値ではない。
  it('リテラル配列の途中で尽きても、式全体が #Timeout になる', () => {
    const huge = `#(${'1 '.repeat(1_000_100)})`;
    expect(evaluatedValue(huge)).toEqual({ kind: 'error', error: 'Timeout' });
  });

  // 予算は評価ごとに作り直す。使い切った評価が次の評価に影響しない。
  it('上限は 1 回の評価ごとに数え直す', () => {
    expect(evaluated('(1 to: 1e400) sum')).toBe('#Timeout');
    expect(evaluated('(1 to: 1000) sum')).toBe('500500');
  });
});

describe('evaluateFormula の String（§6.2）', () => {
  it('連結は文字列どうしだけ。受け手と引数で出るエラーが違う（§6.0）', () => {
    expect(evaluated("'ab' , 'cd'")).toBe("'abcd'");
    expect(evaluated("'ab' , 1")).toBe('#TypeError');
    expect(evaluated("1 , 'ab'")).toBe('#DoesNotUnderstand');
  });

  it('size と isEmpty を送る', () => {
    expect(evaluatedValue("'abc' size")).toEqual({ kind: 'integer', value: 3n });
    expect(evaluated("'' isEmpty")).toBe('true');
    expect(evaluated("'abc' isEmpty")).toBe('false');
  });

  it('大文字小文字の変換は英字以外をそのまま返す', () => {
    expect(evaluated("'a1!' asUppercase")).toBe("'A1!'");
    expect(evaluated("'A1!' asLowercase")).toBe("'a1!'");
  });

  it('indexOf: は部分文字列を取り、見つからなければ 0 を返す', () => {
    expect(evaluated("'abcd' indexOf: 'bc'")).toBe('2');
    expect(evaluated("'abc' indexOf: 'z'")).toBe('0');
    // 空文字列は常に先頭で見つかる。1 起点なので 0 はありえない位置になる。
    expect(evaluated("'abc' indexOf: ''")).toBe('1');
    expect(evaluated("'abc' indexOf: 1")).toBe('#TypeError');
  });

  it('copyFrom:to: が空文字列を返すのは to が from - 1 のときだけ', () => {
    expect(evaluated("'abcde' copyFrom: 2 to: 4")).toBe("'bcd'");
    expect(evaluated("'abc' copyFrom: 2 to: 1")).toBe("''");
    expect(evaluated("'abc' copyFrom: 3 to: 1")).toBe('#SubscriptOutOfBounds');
  });

  it('添字は 1 起点なので 0 は常に範囲外（ADR-0014）', () => {
    expect(evaluated("'abc' copyFrom: 0 to: 2")).toBe('#SubscriptOutOfBounds');
    expect(evaluated("'abc' copyFrom: 1 to: 4")).toBe('#SubscriptOutOfBounds');
  });

  it('添字の型の誤りは範囲外より先に出る（§6.0 の検査の順序）', () => {
    expect(evaluated("'abc' copyFrom: 'x' to: 99")).toBe('#TypeError');
    expect(evaluated("'abc' copyFrom: 1.5 to: 2")).toBe('#TypeError');
  });

  it('asNumber が受理するのは §2.1 の数値リテラルの形ちょうど', () => {
    expect(evaluatedValue("'007' asNumber")).toEqual({ kind: 'integer', value: 7n });
    expect(evaluated("'1e3' asNumber")).toBe('1000');
    // 前後に空白やコメントが付けば形が一致しない。読めなければ nil でエラーではない。
    expect(evaluated("' 42' asNumber")).toBe('nil');
    expect(evaluated("'1E3' asNumber")).toBe('nil');
    expect(evaluated("'5.' asNumber")).toBe('nil');
  });

  it('asNumber は字句エラーになる原文も nil にする', () => {
    // 閉じていないコメントは #Syntax を投げる形だが、読めなかっただけとして nil を返す。
    expect(evaluated("'\"abc' asNumber")).toBe('nil');
  });

  it('asNumber は倍精度に収まらない小数を #Overflow にする（#32）', () => {
    // 形は §2.1 に合う。**値の生成（ADR-0013）まで §2.1 を再利用した帰結**で、
    // リテラル 1.0e400 と同じ値になる。整数には桁数の上限が無いので 1e400 は通る。
    expect(evaluated("'1.0e400' asNumber")).toBe('#Overflow');
    expect(evaluated("'1e400' asNumber")).toBe(evaluated('1e400'));
  });

  it('非 ASCII はコードポイントで数える（暫定。付録 B は未決のまま）', () => {
    // 数え方は付録 B が UI を見てから決めるとしている未決の論点で、ここで固定するのは
    // **実装が何かを選ばざるを得ないための暫定**である。字句解析器が列をコードポイントで
    // 数えるのに揃えた。サロゲートペアを 2 と数える実装との差はここにだけ出る。
    expect(evaluated("'😀ab' size")).toBe('3');
    expect(evaluated("'😀ab' copyFrom: 1 to: 1")).toBe("'😀'");
    expect(evaluated("'😀ab' indexOf: 'a'")).toBe('2');
  });

  it('ifEmpty: は空のときだけ引数を評価する（§5.2）', () => {
    expect(evaluated("'' ifEmpty: ['空']")).toBe("'空'");
    expect(evaluated("'abc' ifEmpty: [1 / 0]")).toBe("'abc'");
    expect(evaluated("'' ifEmpty: 1")).toBe('#TypeError');
  });

  it('= は型が違ってもエラーにならない', () => {
    expect(evaluated("'abc' = 'abc'")).toBe('true');
    expect(evaluated("'abc' = 'ABC'")).toBe('false');
    expect(evaluated("'abc' = 1")).toBe('false');
    expect(evaluated("'abc' ~= nil")).toBe('true');
  });
});

describe('evaluateFormula の Boolean（§6.2）', () => {
  it('& と | は先行評価なので、選ばれない側のエラーも表に出る', () => {
    expect(evaluated('true & false')).toBe('false');
    expect(evaluated('true | false')).toBe('true');
    expect(evaluated('false & (1 / 0)')).toBe('#DivideByZero');
    expect(evaluated('true | (1 / 0)')).toBe('#DivideByZero');
  });

  it('and: と or: は遅延評価なので、選ばれない側は評価されない', () => {
    expect(evaluated('false and: [1 / 0]')).toBe('false');
    expect(evaluated('true or: [1 / 0]')).toBe('true');
    expect(evaluated('true and: [false]')).toBe('false');
  });

  it('短絡して引数を見ない経路でも型は検査する（§5.2 と同じ理由）', () => {
    expect(evaluated('false and: 1')).toBe('#TypeError');
    expect(evaluated('true or: 1')).toBe('#TypeError');
  });

  it('not を送る', () => {
    expect(evaluated('true not')).toBe('false');
    expect(evaluated('false not')).toBe('true');
  });

  it('引数が真偽値でなければ #TypeError、受け手が真偽値でなければ #DoesNotUnderstand', () => {
    expect(evaluated('true & 1')).toBe('#TypeError');
    expect(evaluated('1 & true')).toBe('#DoesNotUnderstand');
    expect(evaluated('1 not')).toBe('#DoesNotUnderstand');
  });
});

describe('evaluateFormula の Symbol と nil（§6.2）', () => {
  it('シンボルと文字列は別のクラスで、両向きとも等しくない', () => {
    expect(evaluated('#foo = #foo')).toBe('true');
    expect(evaluated('#at:put: = #at:')).toBe('false');
    expect(evaluated("#foo = 'foo'")).toBe('false');
    expect(evaluated("'foo' = #foo")).toBe('false');
  });

  it('シンボルは識別子であって文字の並びとして扱わない', () => {
    expect(evaluated('#foo size')).toBe('#DoesNotUnderstand');
    expect(evaluated('#foo asUppercase')).toBe('#DoesNotUnderstand');
  });

  it('isNil と notNil はすべての値が理解する', () => {
    expect(evaluated('nil isNil')).toBe('true');
    expect(evaluated('nil notNil')).toBe('false');
    expect(evaluated('1 isNil')).toBe('false');
    expect(evaluated("'' isNil")).toBe('false');
    expect(evaluated('#(1 2) isNil')).toBe('false');
    expect(evaluated('[1 / 0] isNil')).toBe('false');
  });

  it('ifNil: もすべての値が理解し、引数はブロックでなければならない', () => {
    expect(evaluated('nil ifNil: [0]')).toBe('0');
    // 受け手が nil でなければ引数は評価されない（§5.2）。
    expect(evaluated('1 ifNil: [1 / 0]')).toBe('1');
    expect(evaluated('nil ifNil: 0')).toBe('#TypeError');
    expect(evaluated('1 ifNil: 0')).toBe('#TypeError');
  });

  it('nil は真偽値ではないので論理演算を理解しない', () => {
    expect(evaluated('nil not')).toBe('#DoesNotUnderstand');
    expect(evaluated('nil size')).toBe('#DoesNotUnderstand');
  });

  it('nil の = は型が違ってもエラーにならない', () => {
    expect(evaluated('nil = nil')).toBe('true');
    expect(evaluated('nil = false')).toBe('false');
    expect(evaluated('nil ~= nil')).toBe('false');
  });
});

describe('evaluateFormula の Array（§6.3）', () => {
  it('添字は 1 起点で、範囲外と型の誤りを分ける（ADR-0014）', () => {
    expect(evaluated('#(1 2 3) at: 1')).toBe('1');
    expect(evaluated('#(1 2 3) at: 0')).toBe('#SubscriptOutOfBounds');
    expect(evaluated('#(1 2 3) at: 4')).toBe('#SubscriptOutOfBounds');
    // 型の誤りは範囲外より先に出る（§6.0 の検査の順序）。
    expect(evaluated("#(1 2 3) at: 'x'")).toBe('#TypeError');
    expect(evaluated('#(1 2 3) at: 99.0')).toBe('#TypeError');
  });

  it('first と last は添字アクセスなので、空なら範囲外', () => {
    expect(evaluated('#() first')).toBe('#SubscriptOutOfBounds');
    expect(evaluated('#() last')).toBe('#SubscriptOutOfBounds');
    // 集計は空でも値を返す。単位元があるものだけ（ADR-0010）。
    expect(evaluated('#() sum')).toBe('0');
    expect(evaluated('#() min')).toBe('nil');
  });

  it('集計は値が nil の要素を無視し、列挙は無視しない（ADR-0010）', () => {
    expect(evaluated('#(1 nil 3) sum')).toBe('4');
    expect(evaluated('#(1 nil 3) count')).toBe('2');
    expect(evaluated('#(1 nil 3) size')).toBe('3');
    expect(evaluated('#(1 nil 3) average')).toBe('2');
    expect(evaluated('#(1 nil 3) collect: [:x | x isNil]')).toBe('#(false true false)');
  });

  it('集計は数を要求する。count だけは数えるだけ', () => {
    expect(evaluated("#(1 'a' 3) sum")).toBe('#TypeError');
    expect(evaluated("#(1 'a' 3) max")).toBe('#TypeError');
    expect(evaluated("#(1 'a' 3) count")).toBe('3');
  });

  it('average は §6.1 の / と同じく、割り切れれば整数を返す', () => {
    expect(evaluated('#(1 2 3) average')).toBe('2');
    expect(evaluated('#(1 2 4) average')).toBe('2.3333333333333335');
  });

  it('列挙の結果は常に Array で、要素の順序を保つ', () => {
    expect(evaluated('#(1 2 3) collect: [:x | x * 2]')).toBe('#(2 4 6)');
    expect(evaluated('#(1 2 3) select: [:x | x > 1]')).toBe('#(2 3)');
    expect(evaluated('#(1 2 3) reject: [:x | x > 1]')).toBe('#(1)');
    expect(evaluated('#(1 2 3) inject: 0 into: [:acc :x | acc + x]')).toBe('6');
  });

  it('選び出しのブロックは真偽値を返さなければならない（§7.6 の whileTrue: と同じ）', () => {
    expect(evaluated('#(1 2 3) select: [:x | x]')).toBe('#TypeError');
    expect(evaluated('#(1 2 3) reject: [:x | nil]')).toBe('#TypeError');
    expect(evaluated('#(1 2 3) detect: [:x | x] ifNone: [0]')).toBe('#TypeError');
    expect(evaluated('#(3 1 2) sorted: [:a :b | a]')).toBe('#TypeError');
  });

  it('sorted: は同順の要素の並びを保つ（安定）', () => {
    expect(evaluated('#(3 1 2) sorted: [:a :b | a < b]')).toBe('#(1 2 3)');
    expect(evaluated('#(3 1 2) sorted: [:a :b | a > b]')).toBe('#(3 2 1)');
    // 整数と小数は値が等しいので順序が付かない。元の並びが残る。
    expect(evaluated('#(1 1.0) sorted: [:a :b | a < b]')).toBe('#(1 1.0)');
    expect(evaluated('#(1.0 1) sorted: [:a :b | a < b]')).toBe('#(1.0 1)');
  });

  it('ブロックの中で生じたエラーが式全体の値になる（§6.0）', () => {
    expect(evaluated('#(1 2 3) collect: [:x | x / 0]')).toBe('#DivideByZero');
    expect(evaluated('#(1 2 3) select: [:x | x foo]')).toBe('#DoesNotUnderstand');
    expect(evaluated('#(1 2 3) sorted: [:a :b | a / 0]')).toBe('#DivideByZero');
  });

  // **「評価しない」は受け手が空の場合に限らない。** sorted: の比較は要素が 2 つ以上
  // なければ起こらないので、要素が 1 つなら引数の数も返り値もエラーも問われない。
  it('要素が 1 つの sorted: は比較のブロックを評価しない', () => {
    expect(evaluated('#(1) sorted: [:a :b | a]')).toBe('#(1)');
    expect(evaluated('#(1) sorted: [:x | x]')).toBe('#(1)');
    expect(evaluated('#(1) sorted: [:a :b | a / 0]')).toBe('#(1)');
    expect(evaluated('#() sorted: [:x | x]')).toBe('#()');
    // 比較が起きれば問われる。引数の型は評価しなくても見えるので常に検査する。
    expect(evaluated('#(1 2) sorted: [:a :b | a]')).toBe('#TypeError');
    expect(evaluated('#(1) sorted: 1')).toBe('#TypeError');
  });

  it('受け手が空ならブロックを評価しないので、引数の数も問われない（§5.2 と同じ）', () => {
    expect(evaluated('#() collect: [:a :b | a]')).toBe('#()');
    expect(evaluated('#() inject: 0 into: [:acc | acc]')).toBe('0');
    // 評価される経路では引数の数が問われる（§5.1）。
    expect(evaluated('#(1 2 3) collect: [:a :b | a]')).toBe('#TypeError');
    expect(evaluated('#(1 2 3) inject: 0 into: [:acc | acc]')).toBe('#TypeError');
  });

  it('引数の型は評価されないときも検査する（§5.2 と同じ）', () => {
    expect(evaluated('#(1 2 3) collect: 1')).toBe('#TypeError');
    expect(evaluated('#(1 2 3) detect: [:x | x > 1] ifNone: 0')).toBe('#TypeError');
    expect(evaluated('#(1 2 3) detect: [:x | x > 1] ifNone: [:x | x]')).toBe('2');
  });

  it('等価性は同じクラス・同じ長さ・対応する位置の要素で決まる', () => {
    expect(evaluated('#(1 2) = #(1 2)')).toBe('true');
    expect(evaluated('#(1 2) = #(2 1)')).toBe('false');
    expect(evaluated('#(1 2) = #(1 2 3)')).toBe('false');
    expect(evaluated('#() = #()')).toBe('true');
    // 要素の比較は §6.1 の = に従う。入れ子も要素として比べる。
    expect(evaluated('#(1) = #(1.0)')).toBe('true');
    expect(evaluated('#(1 #(2 3)) = #(1 #(2 3))')).toBe('true');
    expect(evaluated('#(1 #(2 3)) = #(1 #(3 2))')).toBe('false');
    // クラスが違えば等しくない。エラーにはならない（§6.3）。
    expect(evaluated('#(1) = 1')).toBe('false');
    expect(evaluated('#(1 2) ~= #(2 1)')).toBe('true');
  });
});

describe('evaluateFormula の Interval（§6.3、ADR-0016）', () => {
  it('Number への to: は区間を作り、表記は端をそのまま書く', () => {
    expect(evaluated('1 to: 5')).toBe('1 to: 5');
    expect(evaluated('1 to: 3.5')).toBe('1 to: 3.5');
    expect(evaluated("1 to: 'a'")).toBe('#TypeError');
  });

  it('逆向きは空になる。範囲が正規化するのとは逆（ADR-0016）', () => {
    expect(evaluated('5 to: 1')).toBe('5 to: 1');
    expect(evaluated('(5 to: 1) size')).toBe('0');
    expect(evaluated('(5 to: 1) isEmpty')).toBe('true');
    expect(evaluated('(5 to: 1) first')).toBe('#SubscriptOutOfBounds');
    expect(evaluated('(5 to: 1) sum')).toBe('0');
    expect(evaluated('(5 to: 1) max')).toBe('nil');
  });

  it('個数は floor(stop - start) + 1。負なら 0', () => {
    expect(evaluated('(1 to: 3.5) size')).toBe('3');
    expect(evaluated('(1 to: 0.5) size')).toBe('0');
    expect(evaluated('(3 to: 3) size')).toBe('1');
    // 1 を足しても値が変わらない大きさでも、個数が先に決まるので止まる。
    expect(evaluated('(1.0e21 to: 1.0e21) size')).toBe('1');
  });

  it('要素は start + (i - 1) なので、種別は下端から伝染する', () => {
    expect(evaluated('(1 to: 3.5) last')).toBe('3');
    expect(evaluated('(1.5 to: 4) at: 2')).toBe('2.5');
    expect(evaluated('(1.5 to: 4) last')).toBe('3.5');
    expect(evaluated('(10 to: 14) at: 3')).toBe('12');
  });

  it('個数が求まらなければ to: が #Overflow を返す（ADR-0013）', () => {
    expect(evaluated('-1.0e308 to: 1.0e308')).toBe('#Overflow');
    expect(evaluated('(-1.0e308 to: 1.0e308) size')).toBe('#Overflow');
    expect(evaluated('(0.0 to: 1.0e308) isEmpty')).toBe('false');
  });

  it('整数の端は任意精度なので、要素を並べずに個数が決まる', () => {
    expect(evaluated('(1 to: 1e400) isEmpty')).toBe('false');
    expect(evaluated('(1 to: 1e400) first')).toBe('1');
  });

  it('列挙の結果は Array であって Interval ではない', () => {
    expect(evaluated('(1 to: 5) collect: [:x | x * 2]')).toBe('#(2 4 6 8 10)');
    expect(evaluated('(1 to: 5) select: [:x | x > 3]')).toBe('#(4 5)');
    expect(evaluated('(5 to: 1) collect: [:x | x * 2]')).toBe('#()');
  });

  it('区間の要素は数なので value を理解しない', () => {
    expect(evaluated('(1 to: 5) first value')).toBe('#DoesNotUnderstand');
  });

  it('等価性は要素で決まる。端の書き方が違っても要素が同じなら等しい', () => {
    expect(evaluated('(1 to: 3) = (1 to: 3)')).toBe('true');
    expect(evaluated('(1 to: 3) = (1 to: 3.5)')).toBe('true');
    expect(evaluated('(1 to: 3) = (1 to: 4)')).toBe('false');
    expect(evaluated('#(1 2) = (1 to: 2)')).toBe('false');
    expect(evaluated('(1 to: 2) = #(1 2)')).toBe('false');
  });

  it('ifEmpty: の受け手になれる（§5.2）', () => {
    expect(evaluated("(5 to: 1) ifEmpty: ['空']")).toBe("'空'");
    expect(evaluated("(1 to: 5) ifEmpty: ['空']")).toBe('1 to: 5');
  });
});

describe('evaluateFormula の診断（要件 F-8-3）', () => {
  // 値の側は #Syntax のまま（位置が違っても同じ値）で、位置と説明文は組の片割れに載る。
  // ErrorValue に載せると「同じ #Syntax でも位置が違えば別の値か」を決めることになるが、
  // §6.0 は「エラーはメッセージを受け取らない」としか定めていない。
  it('構文エラーは値と診断の組になる', () => {
    const { value, diagnostic } = evaluateFormula('3 +');
    expect(value).toEqual({ kind: 'error', error: 'Syntax' });
    expect(diagnostic).toEqual({
      phase: 'parse',
      line: 1,
      column: 4,
      message: expect.stringContaining('式がありません'),
    });
  });

  // 字句の段階か構文の段階かは、利用者には区別が無くても報告する側に要る。
  it('字句エラーは phase が lexical になる', () => {
    const { value, diagnostic } = evaluateFormula("'abc");
    expect(value).toEqual({ kind: 'error', error: 'Syntax' });
    expect(diagnostic?.phase).toBe('lexical');
    expect(diagnostic?.line).toBe(1);
    expect(diagnostic?.column).toBe(1);
  });

  it('位置は行と列で、2 行目以降も指せる', () => {
    const { diagnostic } = evaluateFormula('3\n+ $');
    expect(diagnostic).toMatchObject({ phase: 'lexical', line: 2, column: 3 });
  });

  it('構文エラーでなければ診断は無い', () => {
    // 値も併せて見る。診断だけを見ると、組になっていない戻り値に対しても通ってしまう。
    const { value, diagnostic } = evaluateFormula('3 + 4');
    expect(value).toEqual({ kind: 'integer', value: 7n });
    expect(diagnostic).toBeUndefined();
  });

  // 評価の途中で出たエラーは位置を持たない。持てるのは構文解析までの段階だけである。
  it('実行時のエラーにも診断は無い', () => {
    const { value, diagnostic } = evaluateFormula('1 / 0');
    expect(value).toEqual({ kind: 'error', error: 'DivideByZero' });
    expect(diagnostic).toBeUndefined();
  });
});
