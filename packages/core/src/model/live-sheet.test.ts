import { describe, expect, it } from 'vitest';
import { printValue } from '../eval/value.ts';
import { type CellAddress, parseAddress, printAddress } from './address.ts';
import { type InvalidationIndex, recordedReads } from './invalidation.ts';
import { LiveSheet, type LiveSheetOptions } from './live-sheet.ts';
import { recalculate } from './recalc.ts';
import { Sheet } from './sheet.ts';

/** 綴りを番地にする。テストの中で `null` を潰すためだけの補助。 */
function addressOf(spelling: string): CellAddress {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} はセル参照の形ではありません。`);
  return address;
}

/** 内容を置いたシートを作る。 */
function liveSheetOf(contents: Record<string, string>, options?: LiveSheetOptions): LiveSheet {
  return new LiveSheet(
    Object.entries(contents).map(([spelling, content]) => [addressOf(spelling), content] as const),
    options,
  );
}

/** セルの値を §0.3 の表記で取る。 */
function cellValue(live: LiveSheet, spelling: string): string {
  return printValue(live.values(addressOf(spelling)));
}

/** 内容を書き、**計算し直したセルの綴り**を整列して返す。並びには意味を持たせない。 */
function put(live: LiveSheet, spelling: string, content: string): readonly string[] {
  return [...live.put(addressOf(spelling), content)].map(printAddress).sort();
}

/** 同じ内容をフル再計算したときの値（§0.3 の表記）。 */
function fullRecalculation(contents: Record<string, string>): (spelling: string) => string {
  const sheet = new Sheet();
  for (const [spelling, content] of Object.entries(contents))
    sheet.put(addressOf(spelling), content);
  const values = recalculate(sheet);
  return (spelling) => printValue(values(addressOf(spelling)));
}

describe('LiveSheet の構築（要件 F-4-2）', () => {
  it('置いた内容がそのまま読める（要件 F-5-1）', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1' });
    expect(live.contentAt(addressOf('A1'))).toBe('1');
    expect(live.contentAt(addressOf('B1'))).toBe('=A1 + 1');
    expect(live.contentAt(addressOf('C1'))).toBe('');
  });

  it('構築した時点で数式セルの値が出る（フル再計算）', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10' });
    expect(cellValue(live, 'C1')).toBe('20');
  });

  it('内容を置く順序に依らない', () => {
    const live = liveSheetOf({ C1: '=B1 * 10', B1: '=A1 + 1', A1: '1' });
    expect(cellValue(live, 'C1')).toBe('20');
  });

  it('解決できない番地へは置けない（Sheet と同じ）', () => {
    const live = liveSheetOf({ A1: '1' });
    expect(() => live.put(addressOf('A0'), '1')).toThrow(/存在しません/);
    expect(() => liveSheetOf({ A0: '1' })).toThrow(/存在しません/);
  });
});

describe('LiveSheet の増分再計算（要件 F-4-2）', () => {
  it('定数を書き換えると、それを読む数式の値が変わる', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1' });
    expect(cellValue(live, 'B1')).toBe('2');

    put(live, 'A1', '10');
    expect(cellValue(live, 'A1')).toBe('10');
    expect(cellValue(live, 'B1')).toBe('11');
  });

  it('数式そのものを書き換えると値が変わる', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1' });
    put(live, 'B1', '=A1 * 100');
    expect(cellValue(live, 'B1')).toBe('100');
  });

  it('下流の下流まで伝わる', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10' });
    put(live, 'A1', '4');
    expect(cellValue(live, 'C1')).toBe('50');
  });

  it('空セルに内容を入れると、それを読んでいた数式が変わる（ADR-0010）', () => {
    const live = liveSheetOf({ B1: '=A1 ifNil: [0]' });
    expect(cellValue(live, 'B1')).toBe('0');

    put(live, 'A1', '5');
    expect(cellValue(live, 'B1')).toBe('5');
  });

  it('セルを空にすると、それを読んでいた数式が変わる（ADR-0010）', () => {
    const live = liveSheetOf({ A1: '5', B1: '=A1 ifNil: [0]' });
    expect(cellValue(live, 'B1')).toBe('5');

    put(live, 'A1', '');
    expect(live.contentAt(addressOf('A1'))).toBe('');
    expect(cellValue(live, 'B1')).toBe('0');
  });

  it('数式を定数に書き換えても下流が追随する', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10' });
    put(live, 'B1', '7');
    expect(cellValue(live, 'C1')).toBe('70');
  });

  it('範囲の中のセルを書き換えると集計が変わる', () => {
    const live = liveSheetOf({ A1: '1', A2: '2', B1: '=A1..A3 sum' });
    expect(cellValue(live, 'B1')).toBe('3');

    put(live, 'A3', '10');
    expect(cellValue(live, 'B1')).toBe('13');
  });

  it('範囲の外のセルを書き換えても集計は変わらない', () => {
    const live = liveSheetOf({ A1: '1', A2: '2', B1: '=A1..A3 sum' });
    put(live, 'A4', '100');
    expect(cellValue(live, 'B1')).toBe('3');
  });

  // **増分でもトポロジカル順序で回す検査**（段階 5 と同じ理由）。下流へ潜って評価すると、
  // 鎖の長さがそのまま再帰の深さになり、スタックが尽きて `#Timeout` になる。
  it('長い鎖の根を書き換えても評価できる', () => {
    const contents: Record<string, string> = { A1: '1' };
    for (let row = 2; row <= 1000; row += 1) contents[`A${row}`] = `=A${row - 1} + 1`;
    const live = liveSheetOf(contents);
    expect(cellValue(live, 'A1000')).toBe('1000');

    put(live, 'A1', '2');
    expect(cellValue(live, 'A1000')).toBe('1001');
  });
});

describe('LiveSheet と循環参照（要件 F-4-3）', () => {
  it('編集で循環を作ると #Circular になる', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1' });
    expect(cellValue(live, 'B1')).toBe('1');

    put(live, 'A1', '=B1');
    expect(cellValue(live, 'A1')).toBe('#Circular');
    expect(cellValue(live, 'B1')).toBe('#Circular');
  });

  it('編集で循環を解くと値が戻る', () => {
    const live = liveSheetOf({ A1: '=B1', B1: '=A1' });
    expect(cellValue(live, 'A1')).toBe('#Circular');

    put(live, 'B1', '3');
    expect(cellValue(live, 'A1')).toBe('3');
    expect(cellValue(live, 'B1')).toBe('3');
  });

  it('3 つの巡りを解いても全員が値を取り戻す', () => {
    const live = liveSheetOf({ A1: '=B1', B1: '=C1', C1: '=A1' });
    expect(cellValue(live, 'B1')).toBe('#Circular');

    put(live, 'C1', '7');
    expect(cellValue(live, 'A1')).toBe('7');
    expect(cellValue(live, 'B1')).toBe('7');
  });

  it('循環に巻き込まれていたセルも、循環が解ければ値を持つ', () => {
    const live = liveSheetOf({ A1: '=A1', B1: '=A1 + 1' });
    expect(cellValue(live, 'B1')).toBe('#Circular');

    put(live, 'A1', '10');
    expect(cellValue(live, 'B1')).toBe('11');
  });
});

describe('LiveSheet の無効化は記録した読みで行う（ADR-0024）', () => {
  // **静的な抽出は範囲の端が式のとき取りこぼす**（ADR-0023）。フル再計算では安全網が
  // 拾っていた穴で、**増分では古い値として残る。** 記録した読みを使う理由がこれである。
  it('静的な抽出に現れない読みでも下流が更新される', () => {
    const live = liveSheetOf({
      A1: '=((A2..A2 detect: [:c | true] ifNone: [nil]) to: C4) sum',
      A2: '1',
      C4: '2',
    });
    expect(cellValue(live, 'A1')).toBe('3');

    put(live, 'B3', '10');
    expect(cellValue(live, 'A1')).toBe('13');
  });

  // **短絡して読まなかったセルは依存ではない。** ADR-0023 が案 B の欠点として挙げていた点だが、
  // **読まなかったセルはその数式の値を変えない**ので、値としては穴にならない。
  // 枝が切り替われば、そのときに新しい値を読む。
  it('読まれなかった枝のセルを書き換えても値は変わらず、枝が切り替われば新しい値を読む', () => {
    const live = liveSheetOf({
      A1: 'true',
      B1: '1',
      C1: '2',
      D1: '=A1 isTrue ifTrue: [B1] ifFalse: [C1]',
    });
    expect(cellValue(live, 'D1')).toBe('1');

    put(live, 'C1', '99');
    expect(cellValue(live, 'D1')).toBe('1');

    put(live, 'A1', 'false');
    expect(cellValue(live, 'D1')).toBe('99');
  });
});

describe('put が返す、計算し直したセル（要件 F-4-2）', () => {
  it('変更したセルとその下流だけを返す', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1 * 10', D1: '=7' });
    expect(put(live, 'A1', '2')).toEqual(['A1', 'B1', 'C1']);
  });

  it('何も読まないセルを書き換えれば、そのセルだけを返す', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1' });
    expect(put(live, 'Z9', '1')).toEqual(['Z9']);
  });

  // **値を読まない数式は下流ではない**（§4.3）。`size` は矩形の大きさだけで決まる。
  it('範囲の大きさしか使わない数式は、範囲の中のセルを書き換えても計算し直さない', () => {
    const live = liveSheetOf({ A1: '1', A2: '2', B1: '=A1..A2 sum', B2: '=A1..A2 size' });
    expect(put(live, 'A2', '5')).toEqual(['A2', 'B1']);
    expect(cellValue(live, 'B1')).toBe('6');
    expect(cellValue(live, 'B2')).toBe('2');
  });

  it('空にしたセルの下流も返る', () => {
    const live = liveSheetOf({ A1: '5', B1: '=A1 ifNil: [0]' });
    expect(put(live, 'A1', '')).toEqual(['A1', 'B1']);
  });
});

describe('LiveSheet はフル再計算と同じ値を出す（要件 F-4-4）', () => {
  it('編集を重ねた後の値は、同じ内容から作り直した値と一致する', () => {
    const live = liveSheetOf({
      A1: '1',
      A2: '=A1 + 1',
      A3: '=A1..A2 sum',
      B1: '=A3 * 2',
      C1: '=C1',
    });
    put(live, 'A1', '5');
    put(live, 'A2', '=A1 * 3');
    put(live, 'C1', '=A3');

    const expected = fullRecalculation({
      A1: '5',
      A2: '=A1 * 3',
      A3: '=A1..A2 sum',
      B1: '=A3 * 2',
      C1: '=A3',
    });
    for (const spelling of ['A1', 'A2', 'A3', 'B1', 'C1', 'D9']) {
      expect(cellValue(live, spelling)).toBe(expected(spelling));
    }
  });

  it('循環を作ってから解いた後も、作り直した値と一致する', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1', C1: '=B1' });
    put(live, 'A1', '=C1');
    expect(cellValue(live, 'C1')).toBe('#Circular');

    put(live, 'A1', '2');
    const expected = fullRecalculation({ A1: '2', B1: '=A1 + 1', C1: '=B1' });
    for (const spelling of ['A1', 'B1', 'C1']) {
      expect(cellValue(live, spelling)).toBe(expected(spelling));
    }
  });
});

describe('無効化の索引は差し替えられる（ADR-0024）', () => {
  /** **何を変更してもすべてのセルを汚す索引。** 方式を替えても値が変わらないことの検査。 */
  function dirtyEverything(): InvalidationIndex {
    const known = new Map<string, CellAddress>();
    return {
      observe(cell) {
        known.set(printAddress(cell), cell);
      },
      forget(cell) {
        known.delete(printAddress(cell));
      },
      readersOf() {
        return known.values();
      },
    };
  }

  it('全部を汚す索引に差し替えても値は変わらない', () => {
    const contents = {
      A1: '=((A2..A2 detect: [:c | true] ifNone: [nil]) to: C4) sum',
      A2: '1',
      C4: '2',
      D1: '=A1 + 1',
    };
    const live = liveSheetOf(contents, { invalidation: dirtyEverything });
    put(live, 'B3', '10');

    const expected = fullRecalculation({ ...contents, B3: '10' });
    for (const spelling of ['A1', 'D1']) {
      expect(cellValue(live, spelling)).toBe(expected(spelling));
    }
  });

  it('依存の抽出を差し替えても値は変わらない（ADR-0023）', () => {
    const live = liveSheetOf(
      { A1: '1', B1: '=A1 + 1', C1: '=B1 * 10' },
      { dependencies: () => [] },
    );
    put(live, 'A1', '2');
    expect(cellValue(live, 'C1')).toBe('30');
  });
});

/**
 * 計算したセルを記録する索引。**いつ計算したか**を外から見るために、既定の索引を包む。
 * セルを計算すると必ず観測が索引に渡る（`Recalculation`）ので、記録が計算の記録になる。
 */
function observing(log: string[]): LiveSheetOptions {
  return {
    invalidation: () => {
      const index = recordedReads();
      return {
        observe(cell, observation) {
          log.push(printAddress(cell));
          index.observe(cell, observation);
        },
        forget: (cell) => index.forget(cell),
        readersOf: (address) => index.readersOf(address),
      };
    },
  };
}

describe('LiveSheet のトランザクション（要件 F-3-4、ADR-0027 の案 C）', () => {
  const contents = { A1: '1', B1: '=A1 + 1', C1: '=B1 * 2' };

  it('書き込みは下流の値を捨てるだけで、計算しない', () => {
    const log: string[] = [];
    const live = liveSheetOf(contents, observing(log));
    log.length = 0;

    live.begin().put(addressOf('A1'), '5');
    expect(log).toEqual([]);
  });

  it('読まれたセルだけをその場で計算する。書き込みは下流に届いている', () => {
    const log: string[] = [];
    const live = liveSheetOf(contents, observing(log));
    log.length = 0;

    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    expect(printValue(transaction.values(addressOf('B1')))).toBe('6');
    expect([...log].sort()).toEqual(['A1', 'B1']);
  });

  it('commit で残りを計算して確定し、計算し直したセルを返す', () => {
    const live = liveSheetOf(contents);
    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    transaction.values(addressOf('B1'));

    // 途中で読んだセルも返す。**描き直す範囲**なので、いつ計算したかを問わない。
    expect([...transaction.commit()].map(printAddress).sort()).toEqual(['A1', 'B1', 'C1']);
    expect(live.contentAt(addressOf('A1'))).toBe('5');
    expect(cellValue(live, 'C1')).toBe('12');
  });

  it('何度書いても commit はそれぞれの下流を返す', () => {
    const live = liveSheetOf({ ...contents, A2: '1', B2: '=A2 + 1' });
    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    transaction.put(addressOf('A2'), '7');

    expect([...transaction.commit()].map(printAddress).sort()).toEqual([
      'A1',
      'A2',
      'B1',
      'B2',
      'C1',
    ]);
    expect(cellValue(live, 'B2')).toBe('8');
  });

  // **控えるのは原文**なので、書き込み先にあった数式もそのまま戻る（ADR-0027）。
  it('rollback で開始前の内容と値に戻る。書き込み先の数式も戻る', () => {
    const live = liveSheetOf(contents);
    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    transaction.put(addressOf('B1'), '7');
    transaction.values(addressOf('C1'));
    transaction.rollback();

    expect(live.contentAt(addressOf('A1'))).toBe('1');
    expect(live.contentAt(addressOf('B1'))).toBe('=A1 + 1');
    expect(cellValue(live, 'B1')).toBe('2');
    expect(cellValue(live, 'C1')).toBe('4');
  });

  it('同じセルに何度書いても、戻るのは開始前の内容', () => {
    const live = liveSheetOf(contents);
    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    transaction.put(addressOf('A1'), '6');
    transaction.rollback();

    expect(live.contentAt(addressOf('A1'))).toBe('1');
    expect(cellValue(live, 'C1')).toBe('4');
  });

  it('空だったセルは空に戻る（ADR-0010）', () => {
    const live = liveSheetOf({ B1: '=A1 isNil' });
    const transaction = live.begin();
    transaction.put(addressOf('A1'), '3');
    expect(cellValue(live, 'B1')).toBe('false');
    transaction.rollback();

    expect(live.contentAt(addressOf('A1'))).toBe('');
    expect(cellValue(live, 'A1')).toBe('nil');
    expect(cellValue(live, 'B1')).toBe('true');
  });

  // **読まれたときの計算も浅い方から回す**（「長い鎖の根を書き換えても評価できる」と同じ理由）。
  // 捨てたセルの上流を潜って評価すると、鎖の長さがそのまま再帰の深さになる。
  it('長い鎖の根に書き込んでから末端を読んでも評価できる', () => {
    const contents: Record<string, string> = { A1: '1' };
    for (let row = 2; row <= 1000; row += 1) contents[`A${row}`] = `=A${row - 1} + 1`;
    const live = liveSheetOf(contents);

    const transaction = live.begin();
    transaction.put(addressOf('A1'), '2');
    expect(printValue(transaction.values(addressOf('A1000')))).toBe('1001');
    transaction.commit();
  });

  // 矩形の依存から上流を探す経路は 2 つある（中のセルを数え上げる／捨てたセルが中にあるかを見る）。
  // 矩形が捨てたセルの数より大きいかで分かれるので、両方の側に鎖を置く。`first` は 1 段で
  // 使うスタックが小さいので、潜って評価したときに尽きる長さまで鎖を伸ばしてある。
  it.each([
    ['矩形が小さい', 1000, (row: number) => `=(A${row - 1} to: A${row - 1}) sum + 1`],
    [
      '矩形が捨てたセルの数より大きい',
      5000,
      (row: number) => `=(A${row - 1} to: XFD${row - 1}) first + 1`,
    ],
  ])('範囲で繋がった長い鎖に書き込んでから末端を読んでも評価できる: %s', (_, length, formula) => {
    const contents: Record<string, string> = { A1: '1' };
    for (let row = 2; row <= length; row += 1) contents[`A${row}`] = formula(row);
    const live = liveSheetOf(contents);

    const transaction = live.begin();
    transaction.put(addressOf('A1'), '2');
    expect(printValue(transaction.values(addressOf(`A${length}`)))).toBe(String(length + 1));
    transaction.commit();
  });

  it('読まれたセルの上流でも、読まれたセルに届かない枝は計算しない', () => {
    const log: string[] = [];
    const live = liveSheetOf({ ...contents, D1: '=A1 - 1' }, observing(log));
    log.length = 0;

    const transaction = live.begin();
    transaction.put(addressOf('A1'), '5');
    transaction.values(addressOf('C1'));
    expect([...log].sort()).toEqual(['A1', 'B1', 'C1']);
  });

  it('rollback の後の値は、開始前の内容からフル再計算した値と一致する（要件 F-4-4）', () => {
    const before = { A1: '1', A2: '=A1 + A3', A3: '=A2', B1: '=(A1 to: A3) size' };
    const live = liveSheetOf(before);
    const transaction = live.begin();
    transaction.put(addressOf('A3'), '10');
    transaction.values(addressOf('A2'));
    transaction.put(addressOf('A4'), '=A2');
    transaction.rollback();

    const expected = fullRecalculation(before);
    for (const spelling of ['A1', 'A2', 'A3', 'A4', 'B1']) {
      expect(cellValue(live, spelling)).toBe(expected(spelling));
    }
  });
});

describe('トランザクションは 1 度に 1 つ（要件 F-3-4）', () => {
  // **開いている間の書き込みはすべて取り消しの対象でなければならない。** 外から書けると、
  // 巻き戻しがその書き込みを知らずに残すか、知らずに消す。
  it('開いている間は LiveSheet に直接は書けない', () => {
    const live = liveSheetOf({ A1: '1' });
    live.begin();
    expect(() => live.put(addressOf('A1'), '2')).toThrow();
  });

  it('開いている間は重ねて開けない', () => {
    const live = liveSheetOf({ A1: '1' });
    live.begin();
    expect(() => live.begin()).toThrow();
  });

  it('閉じたトランザクションには書けず、閉じ直せない', () => {
    const live = liveSheetOf({ A1: '1' });
    const committed = live.begin();
    committed.commit();
    expect(() => committed.put(addressOf('A1'), '2')).toThrow();
    expect(() => committed.commit()).toThrow();
    expect(() => committed.rollback()).toThrow();

    const rolledBack = live.begin();
    rolledBack.rollback();
    expect(() => rolledBack.put(addressOf('A1'), '2')).toThrow();
    expect(() => rolledBack.commit()).toThrow();
  });

  it('閉じた後は直接書けるし、次のトランザクションを開ける', () => {
    const live = liveSheetOf({ A1: '1', B1: '=A1 + 1' });
    live.begin().rollback();
    expect(put(live, 'A1', '2')).toEqual(['A1', 'B1']);
    live.begin().commit();
    expect(cellValue(live, 'B1')).toBe('3');
  });
});
