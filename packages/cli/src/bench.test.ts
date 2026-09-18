import { LiveSheet } from '@sec/core/model';
import { describe, expect, it } from 'vitest';
import {
  exceedances,
  formatReport,
  LIMIT,
  type Measurement,
  measure,
  parseCells,
  REQUIRED_CELLS,
  rangeAggregate,
  scalarChain,
} from './bench.ts';

/** 呼ばれた順に読みを返す時計。**計測の桁が実時間で揺れないようにする。** */
function clockOf(readings: readonly number[]): () => number {
  let index = 0;
  return () => {
    const reading = readings[index] ?? 0;
    index += 1;
    return reading;
  };
}

describe('スカラ鎖のシナリオ', () => {
  it('要求されたセル数ちょうどを作る', () => {
    expect(scalarChain(100).contents).toHaveLength(100);
    // 10 で割り切れない数でも端数を落とさない（最後の行が途中で終わる）
    expect(scalarChain(97).contents).toHaveLength(97);
  });

  // 要件 N-1 が言う「平均依存度 3」。数式セルはどれもちょうど 3 つ読む。
  it('数式セルはどれも 3 つの別々のセルに依存する', () => {
    const formulas = scalarChain(100).contents.filter(([, content]) => content.startsWith('='));
    expect(formulas.length).toBeGreaterThan(0);
    for (const [, content] of formulas) {
      const referenced = content.slice(1).split(' + ');
      expect(referenced).toHaveLength(3);
      expect(new Set(referenced).size).toBe(3);
    }
  });

  // 番地や数式を組み立て損ねると #Ref や #Syntax になる。**値が出ることまで見る。**
  it('どのセルもエラー値にならない', () => {
    const scenario = scalarChain(100);
    const live = new LiveSheet(scenario.contents);
    for (const [address] of scenario.contents) {
      expect(live.values(address).kind).not.toBe('error');
    }
  });

  // 増分再計算（要件 N-1）が測る形。**下流が同じ行に閉じている**ことがこの形の眼目。
  it('定数を 1 つ変えると同じ行の数式セルだけが計算し直される', () => {
    const scenario = scalarChain(100);
    const live = new LiveSheet(scenario.contents);
    // 変えたセル自身 + 同じ行の数式セル 7 つ
    expect(live.put(scenario.edit.address, '999')).toHaveLength(8);
  });

  it('セル数が少なくても壊れない', () => {
    expect(scalarChain(0).contents).toHaveLength(0);
    expect(scalarChain(1).contents).toHaveLength(1);
    // 数式が現れるのは 4 列目から。3 セルまでは定数だけ
    expect(scalarChain(3).contents.every(([, content]) => !content.startsWith('='))).toBe(true);
    expect(scalarChain(4).contents.filter(([, c]) => c.startsWith('=')).length).toBe(1);
  });
});

describe('範囲集計のシナリオ', () => {
  it('要求されたセル数ちょうどを作る', () => {
    expect(rangeAggregate(100).contents).toHaveLength(100);
    expect(rangeAggregate(97).contents).toHaveLength(97);
  });

  // NEXT.md が段階 7 に課した条件。**範囲を含まない形しか測っていない**のを埋める。
  it('範囲を集計する数式を含む', () => {
    const formulas = rangeAggregate(100).contents.filter(([, c]) => c.startsWith('='));
    expect(formulas.length).toBeGreaterThan(0);
    for (const [, content] of formulas) expect(content).toMatch(/^=[A-Z]+\d+\.\.[A-Z]+\d+ sum$/);
  });

  // 矩形の広さが読みの記録に効く（ADR-0024）。**総計は列全体を読む。**
  it('列全体を読む総計のセルを持つ', () => {
    const scenario = rangeAggregate(100);
    const widest = scenario.contents
      .map(([, content]) => /^=A(\d+)\.\.A(\d+) sum$/.exec(content))
      .filter((matched) => matched !== null)
      .map((matched) => Number(matched[2]) - Number(matched[1]) + 1);
    expect(Math.max(...widest)).toBe(90);
  });

  it('どのセルもエラー値にならない', () => {
    const scenario = rangeAggregate(100);
    const live = new LiveSheet(scenario.contents);
    for (const [address] of scenario.contents) {
      expect(live.values(address).kind).not.toBe('error');
    }
  });

  it('定数を 1 つ変えると窓の集計と総計が計算し直される', () => {
    const scenario = rangeAggregate(100);
    const live = new LiveSheet(scenario.contents);
    // 変えたセル自身 + 窓の集計 1 つ + 総計
    expect(live.put(scenario.edit.address, '999')).toHaveLength(3);
  });

  it('セル数が少なくても壊れない', () => {
    expect(rangeAggregate(0).contents).toHaveLength(0);
    // 総計を置く相手がいないので定数だけ
    expect(rangeAggregate(1).contents).toHaveLength(1);
    expect(rangeAggregate(1).contents.every(([, c]) => !c.startsWith('='))).toBe(true);
    expect(rangeAggregate(2).contents).toHaveLength(2);
  });
});

describe('計測', () => {
  it('時計の差を計測とする', () => {
    const measured = measure(scalarChain(20), {
      now: clockOf([0, 10, 100, 130]),
      fullRuns: 1,
      incrementalRuns: 1,
    });
    expect(measured.fullMs).toBe(10);
    expect(measured.incrementalMs).toBe(30);
  });

  // 平均ではなく中央値。**外れ値（GC や OS の割り込み）に引きずられない。**
  it('繰り返した計測の中央値を採る', () => {
    const measured = measure(scalarChain(20), {
      // フル 3 回が 50 / 10 / 30ms、増分 1 回が 5ms
      now: clockOf([0, 50, 100, 110, 200, 230, 300, 305]),
      fullRuns: 3,
      incrementalRuns: 1,
    });
    expect(measured.fullMs).toBe(30);
  });

  // 2 つの平均を取ると、実際には 1 度も測っていない値を報告することになる。
  it('偶数回なら中央の小さい側を採る', () => {
    const measured = measure(scalarChain(20), {
      // 増分 4 回が 40 / 10 / 30 / 20ms
      now: clockOf([0, 0, 10, 50, 60, 70, 100, 130, 200, 220]),
      fullRuns: 1,
      incrementalRuns: 4,
    });
    expect(measured.incrementalMs).toBe(20);
  });

  it('計算し直したセルの数を報告する', () => {
    const measured = measure(scalarChain(100), {
      now: clockOf([]),
      fullRuns: 1,
      incrementalRuns: 1,
    });
    expect(measured.recalculated).toBe(8);
    expect(measured.cells).toBe(100);
  });

  // 説明はレポートに出る。**時間だけを並べると、狙った形になっていないまま
  // 「速い」と読めてしまう**ので、何を測ったかを数字の隣に置く。
  it('シナリオの名前と形の説明を持ち回る', () => {
    const scenario = rangeAggregate(50);
    const measured = measure(scenario, { now: clockOf([]), fullRuns: 1, incrementalRuns: 1 });
    expect(measured.scenario).toBe(scenario.name);
    expect(measured.description).toBe(scenario.description);
  });
});

describe('しきい値の判定', () => {
  const measured = (fullMs: number, incrementalMs: number): Measurement => ({
    scenario: 'テスト',
    description: 'テストの形',
    cells: REQUIRED_CELLS,
    fullMs,
    incrementalMs,
    recalculated: 1,
  });

  it('しきい値の中なら何も挙げない', () => {
    expect(exceedances([measured(999, 99)], REQUIRED_CELLS)).toEqual([]);
  });

  // 要件は「1 秒以内」「100ms 以内」。**ちょうどは超えていない。**
  it('ちょうどしきい値なら超過ではない', () => {
    expect(exceedances([measured(LIMIT.fullMs, LIMIT.incrementalMs)], REQUIRED_CELLS)).toEqual([]);
  });

  it('フル再計算が N-2 を超えたら挙げる', () => {
    const failures = exceedances([measured(LIMIT.fullMs + 1, 1)], REQUIRED_CELLS);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('N-2');
  });

  it('増分が N-1 を超えたら挙げる', () => {
    const failures = exceedances([measured(1, LIMIT.incrementalMs + 1)], REQUIRED_CELLS);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('N-1');
  });

  it('両方超えたら 2 つ挙げる', () => {
    expect(exceedances([measured(9999, 9999)], REQUIRED_CELLS)).toHaveLength(2);
  });

  it('シナリオを 2 つ渡せば両方を見る', () => {
    expect(exceedances([measured(9999, 1), measured(1, 9999)], REQUIRED_CELLS)).toHaveLength(2);
  });

  // 要件 N-1・N-2 が定めているのは 10,000 セルの数字だけ。
  // **別の規模に当てると、根拠の無い合否になる。**
  it('要件が定めていないセル数では合否を出さない', () => {
    expect(exceedances([measured(9999, 9999)], 500)).toEqual([]);
    expect(exceedances([measured(9999, 9999)], REQUIRED_CELLS * 10)).toEqual([]);
  });
});

describe('引数の解釈', () => {
  it('省略すると要件が定める 10,000 セル', () => {
    expect(parseCells([])).toEqual({ cells: REQUIRED_CELLS });
  });

  it('十進の整数を受ける', () => {
    expect(parseCells(['500'])).toEqual({ cells: 500 });
  });

  // 読めない綴りを黙って既定値に倒すと、打ち間違いが「測れた」ことになる。
  it('数値でなければ理由を言う', () => {
    const parsed = parseCells(['いくつか']);
    expect(parsed).toHaveProperty('error');
    expect('error' in parsed && parsed.error).toContain('いくつか');
  });

  it('0 以下は受けない', () => {
    expect(parseCells(['0'])).toHaveProperty('error');
    expect(parseCells(['-1'])).toHaveProperty('error');
  });

  it('小数は受けない', () => {
    expect(parseCells(['1.5'])).toHaveProperty('error');
  });

  it('引数が 2 つ以上あれば理由を言う', () => {
    expect(parseCells(['100', '200'])).toHaveProperty('error');
  });
});

describe('レポート', () => {
  const measured: Measurement = {
    scenario: 'スカラ鎖',
    description: '10 列を 1 行とし、平均依存度 3',
    cells: REQUIRED_CELLS,
    fullMs: 116.134,
    incrementalMs: 0.049,
    recalculated: 8,
  };

  it('シナリオの名前・形の説明・時間・計算し直したセル数を出す', () => {
    const report = formatReport([measured], REQUIRED_CELLS);
    expect(report).toContain('スカラ鎖');
    expect(report).toContain('平均依存度 3');
    expect(report).toContain('116.134ms');
    expect(report).toContain('計算し直したセル 8 件');
  });

  // しきい値を当てないことは、読む人に分かる形で書く。黙って合格に見せない。
  it('要件が定めていないセル数では判定しないと書く', () => {
    expect(formatReport([measured], 500)).toContain('判定はしない');
    expect(formatReport([measured], REQUIRED_CELLS)).not.toContain('判定はしない');
  });
});
