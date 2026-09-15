import { describe, expect, it } from 'vitest';
import {
  formatGoldenFailures,
  type GoldenCase,
  type GoldenInput,
  GoldenParseError,
  parseGoldenFile,
  runGoldenCases,
} from './golden.ts';

describe('parseGoldenFile', () => {
  it('1 行の式と期待値を読み取る', () => {
    const cases = parseGoldenFile('3 + 4 * 2\n=> 14\n');
    expect(cases).toEqual([
      {
        source: '3 + 4 * 2',
        kind: 'formula',
        send: null,
        pending: null,
        expected: '14',
        line: 1,
        sheet: new Map(),
      },
    ]);
  });

  it('空行で区切られた複数のケースを読み取る', () => {
    const text = ['3 + 4\n=> 7', '', '10 sqrt\n=> 3.1622776601683795', ''].join('\n');
    const cases = parseGoldenFile(text);

    expect(cases.map((c) => c.source)).toEqual(['3 + 4', '10 sqrt']);
    expect(cases.map((c) => c.expected)).toEqual(['7', '3.1622776601683795']);
  });

  it('式の開始行を記録する', () => {
    const text = ['"見出し"', '', '3 + 4', '=> 7', '', '1 / 0', '=> #DivideByZero'].join('\n');
    expect(parseGoldenFile(text).map((c) => c.line)).toEqual([3, 6]);
  });

  it('行頭が二重引用符の行をコメントとして読み飛ばす', () => {
    const text = ['"算術の優先順位', '3 + 4 * 2', '"ここもコメント', '=> 14'].join('\n');
    expect(parseGoldenFile(text)).toEqual([
      {
        source: '3 + 4 * 2',
        kind: 'formula',
        send: null,
        pending: null,
        expected: '14',
        line: 2,
        sheet: new Map(),
      },
    ]);
  });

  it('複数行の式をそのまま保持する', () => {
    const text = ['#(1 2 3)', '  inject: 0', '  into: [:a :b | a + b]', '=> 6'].join('\n');
    expect(parseGoldenFile(text)[0]?.source).toBe('#(1 2 3)\n  inject: 0\n  into: [:a :b | a + b]');
  });

  it('複数行の期待値を連結する', () => {
    const text = ['#(1 2)', '=> #(1', '     2)'].join('\n');
    expect(parseGoldenFile(text)[0]?.expected).toBe('#(1\n     2)');
  });

  it('行末の空白を無視する', () => {
    expect(parseGoldenFile('3 + 4   \n=> 7   \n')[0]).toEqual({
      source: '3 + 4',
      kind: 'formula',
      send: null,
      pending: null,
      expected: '7',
      line: 1,
      sheet: new Map(),
    });
  });

  it('CRLF 改行を扱える', () => {
    expect(parseGoldenFile('3 + 4\r\n=> 7\r\n')[0]?.expected).toBe('7');
  });

  it('空のファイルからはケースを作らない', () => {
    expect(parseGoldenFile('')).toEqual([]);
    expect(parseGoldenFile('\n\n  \n')).toEqual([]);
    expect(parseGoldenFile('"コメントだけ\n')).toEqual([]);
  });

  it('期待値の無いケースを拒否する', () => {
    expect(() => parseGoldenFile('3 + 4\n', 'a.txt')).toThrow(GoldenParseError);
    expect(() => parseGoldenFile('3 + 4\n', 'a.txt')).toThrow(/a\.txt:1: 期待値がありません/);
  });

  it('式の無いケースを拒否する', () => {
    expect(() => parseGoldenFile('=> 14\n', 'a.txt')).toThrow(
      /a\.txt:1: "=>" の前に式がありません/,
    );
  });

  it('期待値が空のケースを拒否する', () => {
    expect(() => parseGoldenFile('3 + 4\n=>\n', 'a.txt')).toThrow(/a\.txt:2: 期待値が空です/);
  });

  it('例外に行番号を持たせる', () => {
    try {
      parseGoldenFile('3 + 4\n=> 7\n\n10 sqrt\n', 'a.txt');
      expect.unreachable('GoldenParseError が送出されるはず');
    } catch (error) {
      expect(error).toBeInstanceOf(GoldenParseError);
      expect((error as GoldenParseError).line).toBe(4);
    }
  });
});

describe('parseGoldenFile のシートディレクティブ', () => {
  it('ディレクティブが無ければシートは空', () => {
    const [testCase] = parseGoldenFile('3 + 4\n=> 7\n');
    expect(testCase?.sheet.size).toBe(0);
  });

  it('セルの内容を読み取る', () => {
    const text = ['!A1 := 1', '!A2 := 2', 'A1 + A2', '=> 3'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.source).toBe('A1 + A2');
    expect([...(testCase?.sheet ?? [])]).toEqual([
      ['A1', '1'],
      ['A2', '2'],
    ]);
  });

  it('セルの内容に数式を置ける。最初の := だけが区切り', () => {
    const [testCase] = parseGoldenFile(['!B1 := =A1 + 1', 'B1', '=> 2'].join('\n'));
    expect(testCase?.sheet.get('B1')).toBe('=A1 + 1');
  });

  it('内容に := を含められる。区切りは最初の 1 つだけ', () => {
    const [testCase] = parseGoldenFile(["!A1 := 'a := b'", 'A1', "=> 'a := b'"].join('\n'));
    expect(testCase?.sheet.get('A1')).toBe("'a := b'");
  });

  it('区切りの前後の空白は無視する', () => {
    const [testCase] = parseGoldenFile(['!A1:="abc"', 'A1', "=> 'abc'"].join('\n'));
    expect(testCase?.sheet.get('A1')).toBe('"abc"');
  });

  it('ディレクティブはケースごとに独立している', () => {
    const text = ['!A1 := 1', 'A1', '=> 1', '', 'A1', '=> nil'].join('\n');
    const cases = parseGoldenFile(text);

    expect(cases[0]?.sheet.size).toBe(1);
    expect(cases[1]?.sheet.size).toBe(0);
  });

  it('式の開始行はディレクティブを飛ばした位置になる', () => {
    const [testCase] = parseGoldenFile(['!A1 := 1', 'A1', '=> 1'].join('\n'));
    expect(testCase?.line).toBe(2);
  });

  it('式より後に置かれたディレクティブを拒否する', () => {
    expect(() => parseGoldenFile(['A1', '!A1 := 1', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /a\.txt:2: .*式より前/,
    );
  });

  it('同じセルを 2 回指定したら拒否する', () => {
    expect(() =>
      parseGoldenFile(['!A1 := 1', '!A1 := 2', 'A1', '=> 1'].join('\n'), 'a.txt'),
    ).toThrow(/a\.txt:2: .*A1.*重複/);
  });

  it('セル参照の形でない指定を拒否する', () => {
    // ADR-0007 D-2 の形（大文字の英字 + 数字）だけを受け付ける。
    for (const bad of ['a1', 'A', '1A', 'Abc123', 'A1:B2']) {
      expect(() => parseGoldenFile([`!${bad} := 1`, 'A1', '=> 1'].join('\n'), 'a.txt')).toThrow(
        /セル参照/,
      );
    }
  });

  it('区切りの := が無い指定を拒否する', () => {
    expect(() => parseGoldenFile(['!A1 1', 'A1', '=> 1'].join('\n'), 'a.txt')).toThrow(/a\.txt:1/);
  });

  it('区切りが = だけの指定を拒否する', () => {
    // 代入は := と書く（ADR-0007 D-3）。= を黙って受け入れると 2 通りの書き方が生まれる。
    expect(() => parseGoldenFile(['!A1 = 1', 'A1', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /a\.txt:1: .*":="/,
    );
  });

  it('内容が空の指定を拒否する', () => {
    // 空セルを表したいなら、その行を書かない。D-6 が決まるまで空の意味を固定しない。
    expect(() => parseGoldenFile(['!A1 :=', 'A1', '=> nil'].join('\n'), 'a.txt')).toThrow(
      /a\.txt:1/,
    );
  });

  it('ディレクティブだけで式が無いケースを拒否する', () => {
    expect(() => parseGoldenFile(['!A1 := 1', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /式がありません/,
    );
  });
});

describe('parseGoldenFile の !macro ディレクティブ', () => {
  it('ディレクティブが無ければ数式として読む', () => {
    expect(parseGoldenFile('3 + 4\n=> 7')[0]?.kind).toBe('formula');
  });

  it('!macro があればマクロとして読む', () => {
    const text = ['!macro', '| a |', 'a := 3.', '^ a + 1', '=> 4'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.kind).toBe('macro');
    expect(testCase?.source).toBe('| a |\na := 3.\n^ a + 1');
  });

  it('同じ原文でも開始記号によって期待値が変わる', () => {
    const formula = parseGoldenFile(['^ 3', '=> #Syntax'].join('\n'))[0];
    const macro = parseGoldenFile(['!macro', '^ 3', '=> 3'].join('\n'))[0];

    expect(formula?.kind).toBe('formula');
    expect(macro?.kind).toBe('macro');
    expect(macro?.source).toBe(formula?.source);
  });

  it('セルの指定と併せて書ける', () => {
    const text = ['!macro', '!A1 := 1', 'A2 := A1 + 1.', '^ A2', '=> 2'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.kind).toBe('macro');
    expect(testCase?.sheet.get('A1')).toBe('1');
  });

  it('式の開始行は !macro を飛ばした位置になる', () => {
    const text = ['!macro', '!A1 := 1', '^ A1', '=> 1'].join('\n');
    expect(parseGoldenFile(text)[0]?.line).toBe(3);
  });

  it('指定はケースごとに独立している', () => {
    const text = ['!macro', '^ 1', '=> 1', '', '3 + 4', '=> 7'].join('\n');
    expect(parseGoldenFile(text).map((c) => c.kind)).toEqual(['macro', 'formula']);
  });

  it('!macro がケースの最初の行に無ければ拒否する', () => {
    expect(() =>
      parseGoldenFile(['!A1 := 1', '!macro', '^ A1', '=> 1'].join('\n'), 'a.txt'),
    ).toThrow(/最初の行/);
  });

  it('!macro が重複していたら拒否する', () => {
    expect(() => parseGoldenFile(['!macro', '!macro', '^ 1', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /最初の行/,
    );
  });

  it('式より後の !macro を拒否する', () => {
    expect(() => parseGoldenFile(['^ 1', '!macro', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /式より前/,
    );
  });

  it('!macro だけで式が無いケースを拒否する', () => {
    expect(() => parseGoldenFile(['!macro', '=> 1'].join('\n'), 'a.txt')).toThrow(/式がありません/);
  });

  it('セル参照でもディレクティブ名でもない指定は、書き方を案内して拒否する', () => {
    expect(() => parseGoldenFile(['!macros', '^ 1', '=> 1'].join('\n'), 'a.txt')).toThrow(/!macro/);
  });
});

describe('parseGoldenFile の !macro に添えるメッセージ', () => {
  it('メッセージが無ければ本体そのものを実行する', () => {
    const [testCase] = parseGoldenFile(['!macro', '^ 1', '=> 1'].join('\n'));

    expect(testCase?.kind).toBe('macro');
    expect(testCase?.send).toBeNull();
  });

  it('数式のケースにも送信は無い', () => {
    expect(parseGoldenFile('3 + 4\n=> 7')[0]?.send).toBeNull();
  });

  it('単項セレクタを添えるとマクロ定義として読む', () => {
    const text = ['!macro monthlyTotal', 'monthlyTotal', '    ^ 3', '=> 3'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.kind).toBe('macro');
    expect(testCase?.send).toBe('monthlyTotal');
    expect(testCase?.source).toBe('monthlyTotal\n    ^ 3');
  });

  it('キーワードメッセージを添えられる', () => {
    const text = ['!macro from: 1 to: 3', 'from: start to: end', '    ^ start + end', '=> 4'].join(
      '\n',
    );
    expect(parseGoldenFile(text)[0]?.send).toBe('from: 1 to: 3');
  });

  it('送信の前後の空白は無視する', () => {
    const text = ['!macro   monthlyTotal   ', 'monthlyTotal', '    ^ 3', '=> 3'].join('\n');
    expect(parseGoldenFile(text)[0]?.send).toBe('monthlyTotal');
  });

  it('セルの指定と併せて書ける', () => {
    const text = ['!macro summarize', '!A1 := 1', 'summarize', '    ^ A1', '=> 1'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.send).toBe('summarize');
    expect(testCase?.sheet.get('A1')).toBe('1');
  });

  it('メッセージ付きの !macro も最初の行にだけ置ける', () => {
    expect(() =>
      parseGoldenFile(['!A1 := 1', '!macro monthlyTotal', '^ A1', '=> 1'].join('\n'), 'a.txt'),
    ).toThrow(/最初の行/);
  });

  it('!macro で始まるだけの語はディレクティブにしない', () => {
    expect(() => parseGoldenFile(['!macros', '^ 1', '=> 1'].join('\n'), 'a.txt')).toThrow(/!macro/);
  });
});

/** シートを使わないケースを組み立てる。 */
const plainCase = (source: string, expected: string, line: number): GoldenCase => ({
  source,
  kind: 'formula',
  send: null,
  pending: null,
  expected,
  line,
  sheet: new Map(),
});

describe('runGoldenCases', () => {
  const cases: GoldenCase[] = [plainCase('3 + 4', '7', 1), plainCase('10 sqrt', '3.16', 4)];

  it('評価器に原文・シート・開始記号・送信を渡す', () => {
    const text = ['!macro monthlyTotal', '!A1 := 1', 'monthlyTotal', '    ^ A1', '=> 1'].join('\n');
    const [testCase] = parseGoldenFile(text);
    let received: GoldenInput | undefined;

    runGoldenCases(testCase === undefined ? [] : [testCase], (input) => {
      received = input;
      return '1';
    });

    expect(received?.source).toBe('monthlyTotal\n    ^ A1');
    expect(received?.sheet.get('A1')).toBe('1');
    expect(received?.kind).toBe('macro');
    expect(received?.send).toBe('monthlyTotal');
  });

  it('期待値と行番号は評価器に渡さない', () => {
    const [testCase] = parseGoldenFile('3 + 4\n=> 7');
    let received: GoldenInput | undefined;

    runGoldenCases(testCase === undefined ? [] : [testCase], (input) => {
      received = input;
      return '7';
    });

    expect(received).not.toHaveProperty('expected');
    expect(received).not.toHaveProperty('line');
  });

  it('全て一致すれば失敗を返さない', () => {
    const failures = runGoldenCases(cases, ({ source }) => (source === '3 + 4' ? '7' : '3.16'));
    expect(failures).toEqual([]);
  });

  it('一致しないケースを実際の値付きで返す', () => {
    const failures = runGoldenCases(cases, () => '7');

    expect(failures).toHaveLength(1);
    expect(failures[0]?.testCase.source).toBe('10 sqrt');
    expect(failures[0]?.actual).toBe('7');
    expect(failures[0]?.thrown).toBeNull();
  });

  it('例外を捕捉して残りのケースを続行する', () => {
    const evaluated: string[] = [];
    const failures = runGoldenCases(cases, ({ source }) => {
      evaluated.push(source);
      if (source === '3 + 4') throw new Error('未実装');
      return '3.16';
    });

    expect(evaluated).toEqual(['3 + 4', '10 sqrt']);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.actual).toBeNull();
    expect(failures[0]?.thrown).toBe('未実装');
  });

  it('Error 以外が投げられても文字列化する', () => {
    const failures = runGoldenCases([cases[0] as GoldenCase], () => {
      throw 'ただの文字列';
    });
    expect(failures[0]?.thrown).toBe('ただの文字列');
  });
});

describe('formatGoldenFailures', () => {
  it('ファイルと行を辿れる形にまとめる', () => {
    const failures = runGoldenCases([plainCase('3 + 4', '7', 12)], () => '8');
    const message = formatGoldenFailures(failures, 'arithmetic.txt');

    expect(message).toContain('arithmetic.txt: 1 件のゴールデンテストが失敗しました。');
    expect(message).toContain('arithmetic.txt:12');
    expect(message).toContain('期待値: 7');
    expect(message).toContain('実際  : 8');
  });

  it('例外で終わったケースは例外として表示する', () => {
    const failures = runGoldenCases([plainCase('x', '1', 3)], () => {
      throw new Error('未実装');
    });
    expect(formatGoldenFailures(failures, 'a.txt')).toContain('例外  : 未実装');
  });

  it('複数行の式を字下げして表示する', () => {
    const failures = runGoldenCases([plainCase('| a |\n^ a', 'nil', 1)], () => 'x');
    expect(formatGoldenFailures(failures, 'a.txt')).toContain('式    : | a |\n          ^ a');
  });
});

describe('parseGoldenFile の !pending ディレクティブ', () => {
  it('ディレクティブが無ければ保留ではない', () => {
    expect(parseGoldenFile('3 + 4\n=> 7')[0]?.pending).toBeNull();
  });

  it('保留にするマイルストーンを読み取る', () => {
    const text = ['!pending m3', '!A1 := 1', 'A1 + 1', '=> 2'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.pending).toBe('m3');
    expect(testCase?.source).toBe('A1 + 1');
    expect(testCase?.sheet.get('A1')).toBe('1');
  });

  it('小数点を含むマイルストーン名も読み取る', () => {
    expect(parseGoldenFile(['!pending m3.5', '3 + 4', '=> 7'].join('\n'))[0]?.pending).toBe('m3.5');
  });

  it('!macro の後ろに置ける', () => {
    const text = ['!macro', '!pending m4', '^ 3', '=> 3'].join('\n');
    const [testCase] = parseGoldenFile(text);

    expect(testCase?.kind).toBe('macro');
    expect(testCase?.pending).toBe('m4');
  });

  it('式の開始行は !pending を飛ばした位置になる', () => {
    const text = ['!pending m3', '!A1 := 1', 'A1', '=> 1'].join('\n');
    expect(parseGoldenFile(text)[0]?.line).toBe(3);
  });

  it('ケースごとに独立している', () => {
    const text = ['!pending m3', 'A1', '=> nil', '', '3 + 4', '=> 7'].join('\n');
    expect(parseGoldenFile(text).map((c) => c.pending)).toEqual(['m3', null]);
  });

  it('セルの指定より後ろに置かれたら拒否する', () => {
    expect(() =>
      parseGoldenFile(['!A1 := 1', '!pending m3', 'A1', '=> 1'].join('\n'), 'a.txt'),
    ).toThrow(/!pending/);
  });

  it('重複していたら拒否する', () => {
    expect(() =>
      parseGoldenFile(['!pending m3', '!pending m4', '3', '=> 3'].join('\n'), 'a.txt'),
    ).toThrow(/!pending/);
  });

  it('マイルストーン名が無ければ拒否する', () => {
    expect(() => parseGoldenFile(['!pending', '3', '=> 3'].join('\n'), 'a.txt')).toThrow(
      /マイルストーン/,
    );
  });

  it('マイルストーン名の形でなければ拒否する', () => {
    expect(() => parseGoldenFile(['!pending あとで', '3', '=> 3'].join('\n'), 'a.txt')).toThrow(
      /マイルストーン/,
    );
  });

  it('!pending だけで式が無いケースを拒否する', () => {
    expect(() => parseGoldenFile(['!pending m3', '=> 1'].join('\n'), 'a.txt')).toThrow(
      /式がありません/,
    );
  });
});

describe('runGoldenCases の保留のケース', () => {
  const pendingCase = (source: string, expected: string): GoldenCase => ({
    ...plainCase(source, expected, 1),
    pending: 'm3',
  });

  it('期待値と一致しなくても失敗にしない', () => {
    expect(runGoldenCases([pendingCase('A1', '1')], () => '#Ref')).toEqual([]);
  });

  it('例外で終わっても失敗にしない', () => {
    const failures = runGoldenCases([pendingCase('A1', '1')], () => {
      throw new Error('セル参照は未実装');
    });
    expect(failures).toEqual([]);
  });

  it('通ってしまったら、印が古いものとして失敗に含める', () => {
    const failures = runGoldenCases([pendingCase('A1', '1')], () => '1');

    expect(failures).toHaveLength(1);
    expect(failures[0]?.testCase.pending).toBe('m3');
    expect(failures[0]?.actual).toBe('1');
  });

  it('保留でないケースの判定は変わらない', () => {
    const failures = runGoldenCases([plainCase('3 + 4', '7', 1)], () => '8');
    expect(failures).toHaveLength(1);
  });
});

describe('parseGoldenFile の !pending が受け付けるマイルストーン名', () => {
  // 要件定義書 §8 のマイルストーン。印を外す契機は、そのマイルストーンが来ることだけである。
  const milestones = ['m0', 'm0.5', 'm1', 'm2', 'm3', 'm3.5', 'm4', 'm5', 'm6', 'm7'];

  it.each(milestones)('実在するマイルストーン %s を受け付ける', (milestone) => {
    expect(parseGoldenFile([`!pending ${milestone}`, '3', '=> 3'].join('\n'))[0]?.pending).toBe(
      milestone,
    );
  });

  // 存在しない名前を通すと、どのマイルストーンでも外されない印になり、
  // そのケースが恒久的に検査の外へ出る（ADR-0019）。
  it.each(['m33', 'm99', 'm8', 'm1.5', 'm01', 'm', 'M3', 'm3.0'])(
    '存在しないマイルストーン %s を拒否する',
    (milestone) => {
      expect(() =>
        parseGoldenFile([`!pending ${milestone}`, '3', '=> 3'].join('\n'), 'a.txt'),
      ).toThrow(/マイルストーン/);
    },
  );
});
