import { describe, expect, it } from 'vitest';
import { LIMIT, type Measurement, REQUIRED_CELLS } from './bench.ts';
import { benchResult, type CommandHost, runCommand } from './command.ts';
import { executeMacro } from './macro.ts';

describe('sec eval', () => {
  it('式を評価して値を表示する', async () => {
    expect(await runCommand(['eval', '3 + 4 * 2'])).toEqual({
      stdout: '14\n',
      stderr: '',
      exitCode: 0,
    });
  });

  // 表記は §0.3 が定める 1 つ（printValue）。CLI 専用の字面を作ると、
  // ゴールデンテストの期待値と CLI の出力が食い違う。
  it('表記はゴールデンテストの期待値と同じ', async () => {
    expect((await runCommand(['eval', '#(1 2 3)'])).stdout).toBe('#(1 2 3)\n');
    expect((await runCommand(['eval', "'It''s'"])).stdout).toBe("'It''s'\n");
    expect((await runCommand(['eval', '1.5e3'])).stdout).toBe('1500.0\n');
    expect((await runCommand(['eval', '[:x | x]'])).stdout).toBe('aBlock\n');
  });

  // エラーは値だが（要件 F-8-1）、Bash から && でつないだときに失敗が伝わってほしい。
  it('結果がエラー値なら終了コード 1', async () => {
    expect(await runCommand(['eval', '1 / 0'])).toEqual({
      stdout: '#DivideByZero\n',
      stderr: '',
      exitCode: 1,
    });
  });

  it('構文エラーは値を stdout に、位置と説明文を stderr に出す', async () => {
    const result = await runCommand(['eval', '3 +']);
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toContain('1:4');
    expect(result.stderr).toContain('式がありません');
    expect(result.exitCode).toBe(1);
  });

  it('字句エラーにも位置が付く', async () => {
    const result = await runCommand(['eval', "'abc"]);
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toContain('1:1');
    expect(result.exitCode).toBe(1);
  });

  // 実行時のエラーは位置を持たない。持たないものを 0:0 のように埋めない。
  it('実行時のエラーに位置は付かない', async () => {
    // stdout も見る。stderr だけを見ると、何も出さない実装に対しても通ってしまう。
    const result = await runCommand(['eval', '1 / 0']);
    expect(result.stdout).toBe('#DivideByZero\n');
    expect(result.stderr).toBe('');
  });

  // **未実装に当たったときの終了コード 2 を検査するケースがここに無い。**
  // `sec eval` が受け付ける数式で到達できる未実装が、M3 段階 3（範囲）で尽きたためである。
  // 残る未実装は数式セル（シートが要る）とマクロ（`sec` がまだ読まない）で、どちらも
  // 引数からは届かない。**経路は残す**——消すと、次に未実装へ当たったときに
  // 例外がそのまま漏れて終了コード 1（エラー値）と見分けが付かなくなる。
});

describe('sec の使い方', () => {
  it('引数が無ければ使い方を stderr に出して終了コード 2', async () => {
    const result = await runCommand([]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('使い方');
    expect(result.exitCode).toBe(2);
  });

  it('知らないサブコマンドはその綴りを言う', async () => {
    const result = await runCommand(['evaluate', '3']);
    expect(result.stderr).toContain('evaluate');
    expect(result.exitCode).toBe(2);
  });

  it('eval に式が無ければ終了コード 2', async () => {
    expect((await runCommand(['eval'])).exitCode).toBe(2);
  });

  // 式を 2 つ渡されたとき、黙って 1 つ目だけ評価すると誤りに気付けない。
  it('eval に式が 2 つ以上あれば終了コード 2', async () => {
    const result = await runCommand(['eval', '1 + 1', '2 + 2']);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(2);
  });

  it('--help は使い方を stdout に出して終了コード 0', async () => {
    const result = await runCommand(['--help']);
    expect(result.stdout).toContain('使い方');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('-h も同じ', async () => {
    const short = await runCommand(['-h']);
    expect(short.stdout).toContain('使い方');
    expect(short).toEqual(await runCommand(['--help']));
  });
});

describe('sec bench', () => {
  // 既定の 10,000 セルは実行に時間がかかるので、振る舞いは小さな規模で見る。
  it('2 つのシナリオを計測してレポートを stdout に出す', async () => {
    const result = await runCommand(['bench', '200']);
    expect(result.stdout).toContain('スカラ鎖');
    expect(result.stdout).toContain('範囲集計');
    expect(result.exitCode).toBe(0);
  });

  // 数字を読まずに回帰を判定できることが、CI に載せる前提（開発方針のリスク表）。
  it('しきい値の中なら終了コード 0 で stderr は空', async () => {
    const result = await runCommand(['bench', '200']);
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('セル数が数値でなければ終了コード 2', async () => {
    const result = await runCommand(['bench', 'いくつか']);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(2);
  });

  // 0 セルのシートは測る意味が無く、負の数は形として誤り。黙って直さない。
  it('セル数が 0 以下なら終了コード 2', async () => {
    expect((await runCommand(['bench', '0'])).exitCode).toBe(2);
    expect((await runCommand(['bench', '-1'])).exitCode).toBe(2);
  });

  it('小数のセル数は受け付けない', async () => {
    expect((await runCommand(['bench', '1.5'])).exitCode).toBe(2);
  });

  it('引数が 2 つ以上あれば終了コード 2', async () => {
    expect((await runCommand(['bench', '100', '200'])).exitCode).toBe(2);
  });

  it('使い方に bench が載っている', async () => {
    expect((await runCommand(['--help'])).stdout).toContain('bench');
  });
});

describe('ベンチの計測を出力に直す', () => {
  const measured = (fullMs: number, incrementalMs: number): Measurement => ({
    scenario: 'テスト',
    description: 'テストの形',
    cells: REQUIRED_CELLS,
    fullMs,
    incrementalMs,
    recalculated: 1,
  });

  // **CI が回帰で落ちる経路そのもの。** ここが壊れると、しきい値を超えても緑になる。
  it('しきい値を超えたら終了コード 1 と理由を返す', async () => {
    const result = benchResult(
      [measured(LIMIT.fullMs + 1, LIMIT.incrementalMs + 1)],
      REQUIRED_CELLS,
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('N-2');
    expect(result.stderr).toContain('N-1');
  });

  // 超過していてもレポートは出す。どれだけ超えたかが分からないと直しようがない。
  it('超過してもレポートは stdout に出す', async () => {
    const result = benchResult([measured(9999, 9999)], REQUIRED_CELLS);
    expect(result.stdout).toContain('テスト');
  });

  it('しきい値の中なら終了コード 0 で stderr は空', async () => {
    const result = benchResult([measured(1, 1)], REQUIRED_CELLS);
    expect(result).toMatchObject({ stderr: '', exitCode: 0 });
  });

  // 要件が数字を定めていない規模では合否を出さない（bench.ts の exceedances）。
  it('要件が定めていないセル数なら超過していても終了コード 0', async () => {
    expect(benchResult([measured(9999, 9999)], 500).exitCode).toBe(0);
  });
});

describe('sec run', () => {
  /**
   * ファイルを覚えておき、マクロを Worker を使わずに走らせるホスト。
   * **時間の上限は `worker-host.test.ts` が実際の Worker で見る。** ここは受け渡しだけ。
   */
  const hostWith = (files: Record<string, string>, timedOut = false) => {
    const written = new Map<string, string>();
    const timeouts: number[] = [];
    const host: CommandHost = {
      readText: (path) => {
        const text = files[path];
        if (text === undefined) throw new Error(`ENOENT: ${path}`);
        return text;
      },
      writeText: (path, text) => {
        if (path.startsWith('/readonly/')) throw new Error(`EACCES: ${path}`);
        written.set(path, text);
      },
      runMacro: async (request, timeoutMs) => {
        timeouts.push(timeoutMs);
        return timedOut ? { kind: 'timedOut' } : executeMacro(request);
      },
    };
    return { host, written, timeouts };
  };

  it('マクロを走らせて値を stdout に出す', async () => {
    const { host } = hostWith({ 'm.st': '^ 3 + 4' });
    expect(await runCommand(['run', 'm.st'], host)).toEqual({
      stdout: '7\n',
      stderr: '',
      exitCode: 0,
    });
  });

  // 値の後に、確定した書き込みを `番地 := 内容` の形で出す（ゴールデンテストの `!A1 := 1` と同じ区切り）。
  it('値に続けて書き込んだセルを行の順に出す', async () => {
    const { host } = hostWith({ 'm.st': "C1 := 'done'. A2 := 1. B1 := 6. ^ 6" });
    expect((await runCommand(['run', 'm.st'], host)).stdout).toBe(
      "6\nB1 := 6\nC1 := 'done'\nA2 := 1\n",
    );
  });

  // 内容が空なら区切りの後に何も書かない。末尾の空白は見えないため。
  it('空にしたセルは区切りだけで出す', async () => {
    const { host } = hostWith({ 'm.st': 'A1 := nil', 'in.json': '{"A1": "3"}' });
    expect((await runCommand(['run', 'm.st', '--sheet', 'in.json'], host)).stdout).toBe(
      'nil\nA1 :=\n',
    );
  });

  it('--sheet のセルをマクロが読む', async () => {
    const { host } = hostWith({ 'm.st': '^ A1 value * 2', 'in.json': '{"A1": "21"}' });
    expect((await runCommand(['run', 'm.st', '--sheet', 'in.json'], host)).stdout).toBe('42\n');
  });

  it('--out に実行後の空でない全セルを同じ形式で書く', async () => {
    const { host, written } = hostWith({
      'm.st': 'B1 := A1 value * 2',
      'in.json': '{"A1": "3", "A2": "=A1 + 1"}',
    });
    await runCommand(['run', 'm.st', '--sheet', 'in.json', '--out', 'out.json'], host);
    expect(JSON.parse(written.get('out.json') ?? 'null')).toEqual({
      A1: '3',
      B1: '6',
      A2: '=A1 + 1',
    });
  });

  it('--out が無ければ何も書かない', async () => {
    const { host, written } = hostWith({ 'm.st': 'A1 := 3' });
    await runCommand(['run', 'm.st'], host);
    expect(written.size).toBe(0);
  });

  // 失敗したマクロは巻き戻る（F-3-4）。書き込みは出さず、--out は開始前のシートになる。
  it('エラーで終わったら終了コード 1 で、書き込みを出さない', async () => {
    const { host, written } = hostWith({
      'm.st': 'A1 := 9. ^ 1 / 0',
      'in.json': '{"A1": "3"}',
    });
    const result = await runCommand(
      ['run', 'm.st', '--sheet', 'in.json', '--out', 'out.json'],
      host,
    );
    expect(result).toEqual({ stdout: '#DivideByZero\n', stderr: '', exitCode: 1 });
    expect(JSON.parse(written.get('out.json') ?? 'null')).toEqual({ A1: '3' });
  });

  it('構文エラーは位置と説明文を stderr に出す', async () => {
    const { host } = hostWith({ 'm.st': '| a |\n^ a +' });
    const result = await runCommand(['run', 'm.st'], host);
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toMatch(/^2:\d+: /);
    expect(result.exitCode).toBe(1);
  });

  it('--send で宣言部を持つ定義を起動する', async () => {
    const { host } = hostWith({ 'm.st': 'from: a to: b\n  ^ a + b' });
    expect((await runCommand(['run', 'm.st', '--send', 'from: 1 to: 3'], host)).stdout).toBe('4\n');
  });

  it('読めない --send は終了コード 2', async () => {
    const { host } = hostWith({ 'm.st': 'from: a to: b\n  ^ a + b' });
    const result = await runCommand(['run', 'm.st', '--send', 'from: 1 to:'], host);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('from: 1 to:');
    expect(result.exitCode).toBe(2);
  });

  describe('時間の上限', () => {
    it('既定は 5000ms', async () => {
      const { host, timeouts } = hostWith({ 'm.st': '^ 1' });
      await runCommand(['run', 'm.st'], host);
      expect(timeouts).toEqual([5000]);
    });

    it('--timeout で変えられる', async () => {
      const { host, timeouts } = hostWith({ 'm.st': '^ 1' });
      await runCommand(['run', 'm.st', '--timeout', '250'], host);
      expect(timeouts).toEqual([250]);
    });

    it.each(['0', '-1', '1.5', 'すぐ', ''])('--timeout %j は終了コード 2', async (value) => {
      const { host, timeouts } = hostWith({ 'm.st': '^ 1' });
      const result = await runCommand(['run', 'm.st', '--timeout', value], host);
      expect(result.exitCode).toBe(2);
      expect(timeouts).toEqual([]);
    });

    // Node のタイマーは 2^31 - 1 ms を超える遅延を 1ms に丸める。受け付けると、
    // 長く待つ指定がほぼ即座の打ち切りに化ける（AI レビューの指摘）。
    it('タイマーが扱える最大の 2147483647 は受け付ける', async () => {
      const { host, timeouts } = hostWith({ 'm.st': '^ 1' });
      await runCommand(['run', 'm.st', '--timeout', '2147483647'], host);
      expect(timeouts).toEqual([2147483647]);
    });

    it('2147483648 以上は終了コード 2', async () => {
      const { host, timeouts } = hostWith({ 'm.st': '^ 1' });
      const result = await runCommand(['run', 'm.st', '--timeout', '2147483648'], host);
      expect(result.exitCode).toBe(2);
      expect(result.stderr).toContain('2147483647');
      expect(timeouts).toEqual([]);
    });

    // 打ち切ったマクロの書き込みは反映しない（ADR-0027）。--out は開始前のシートになる。
    it('超えたら #Timeout を出し、終了コード 1', async () => {
      const { host, written } = hostWith({ 'm.st': 'A1 := 9', 'in.json': '{"A1": "3"}' }, true);
      const result = await runCommand(
        ['run', 'm.st', '--sheet', 'in.json', '--out', 'out.json', '--timeout', '100'],
        host,
      );
      expect(result.stdout).toBe('#Timeout\n');
      // ステップ数の上限の #Timeout と見分けられるように、時間で打ち切ったことを言う。
      expect(result.stderr).toContain('100ms');
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(written.get('out.json') ?? 'null')).toEqual({ A1: '3' });
    });
  });

  describe('使い方の誤り', () => {
    const { host } = hostWith({ 'm.st': '^ 1', 'bad.json': '{"A1": 3}' });

    it.each([
      ['マクロのファイルが無い', ['run']],
      ['マクロのファイルが 2 つ', ['run', 'm.st', 'n.st']],
      ['知らないオプション', ['run', 'm.st', '--verbose']],
      ['オプションの値が無い', ['run', 'm.st', '--sheet']],
      ['同じオプションが 2 度', ['run', 'm.st', '--send', 'a', '--send', 'b']],
    ])('%s なら終了コード 2', async (_, argv) => {
      const result = await runCommand(argv, host);
      expect(result.stdout).toBe('');
      expect(result.exitCode).toBe(2);
    });

    it('読めないマクロのファイルはそのパスを言う', async () => {
      const result = await runCommand(['run', 'missing.st'], host);
      expect(result.stderr).toContain('missing.st');
      expect(result.exitCode).toBe(2);
    });

    it('読めないシートのファイルはそのパスを言う', async () => {
      const result = await runCommand(['run', 'm.st', '--sheet', 'missing.json'], host);
      expect(result.stderr).toContain('missing.json');
      expect(result.exitCode).toBe(2);
    });

    it('シートの JSON の誤りは理由を言う', async () => {
      const result = await runCommand(['run', 'm.st', '--sheet', 'bad.json'], host);
      expect(result.stderr).toContain('bad.json');
      expect(result.stderr).toContain('A1');
      expect(result.exitCode).toBe(2);
    });

    // 値は出す。マクロは走り終えており、書けなかったのは出力先だけである。
    it('--out に書けなければそのパスを言って終了コード 2', async () => {
      const result = await runCommand(['run', 'm.st', '--out', '/readonly/out.json'], host);
      expect(result.stdout).toBe('1\n');
      expect(result.stderr).toContain('/readonly/out.json');
      expect(result.exitCode).toBe(2);
    });
  });

  it('使い方に run が載っている', async () => {
    expect((await runCommand(['--help'])).stdout).toContain('sec run');
  });
});
