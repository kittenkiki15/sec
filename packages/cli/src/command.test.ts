import { describe, expect, it } from 'vitest';
import { runCommand } from './command.ts';

describe('sec eval', () => {
  it('式を評価して値を表示する', () => {
    expect(runCommand(['eval', '3 + 4 * 2'])).toEqual({
      stdout: '14\n',
      stderr: '',
      exitCode: 0,
    });
  });

  // 表記は §0.3 が定める 1 つ（printValue）。CLI 専用の字面を作ると、
  // ゴールデンテストの期待値と CLI の出力が食い違う。
  it('表記はゴールデンテストの期待値と同じ', () => {
    expect(runCommand(['eval', '#(1 2 3)']).stdout).toBe('#(1 2 3)\n');
    expect(runCommand(['eval', "'It''s'"]).stdout).toBe("'It''s'\n");
    expect(runCommand(['eval', '1.5e3']).stdout).toBe('1500.0\n');
    expect(runCommand(['eval', '[:x | x]']).stdout).toBe('aBlock\n');
  });

  // エラーは値だが（要件 F-8-1）、Bash から && でつないだときに失敗が伝わってほしい。
  it('結果がエラー値なら終了コード 1', () => {
    expect(runCommand(['eval', '1 / 0'])).toEqual({
      stdout: '#DivideByZero\n',
      stderr: '',
      exitCode: 1,
    });
  });

  it('構文エラーは値を stdout に、位置と説明文を stderr に出す', () => {
    const result = runCommand(['eval', '3 +']);
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toContain('1:4');
    expect(result.stderr).toContain('式がありません');
    expect(result.exitCode).toBe(1);
  });

  it('字句エラーにも位置が付く', () => {
    const result = runCommand(['eval', "'abc"]);
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toContain('1:1');
    expect(result.exitCode).toBe(1);
  });

  // 実行時のエラーは位置を持たない。持たないものを 0:0 のように埋めない。
  it('実行時のエラーに位置は付かない', () => {
    // stdout も見る。stderr だけを見ると、何も出さない実装に対しても通ってしまう。
    const result = runCommand(['eval', '1 / 0']);
    expect(result.stdout).toBe('#DivideByZero\n');
    expect(result.stderr).toBe('');
  });

  // 未実装は仕様上のエラーではないので、#Ref などの値に化けさせない（M3 / M4 で実装する）。
  // セルからの範囲（§4.3）が M3 段階 3 の宿題として残っている。
  it('まだ評価できない式は終了コード 2 で、エラー値にしない', () => {
    const result = runCommand(['eval', 'A1..B2']);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('未実装');
    expect(result.exitCode).toBe(2);
  });
});

describe('sec の使い方', () => {
  it('引数が無ければ使い方を stderr に出して終了コード 2', () => {
    const result = runCommand([]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('使い方');
    expect(result.exitCode).toBe(2);
  });

  it('知らないサブコマンドはその綴りを言う', () => {
    const result = runCommand(['evaluate', '3']);
    expect(result.stderr).toContain('evaluate');
    expect(result.exitCode).toBe(2);
  });

  it('eval に式が無ければ終了コード 2', () => {
    expect(runCommand(['eval']).exitCode).toBe(2);
  });

  // 式を 2 つ渡されたとき、黙って 1 つ目だけ評価すると誤りに気付けない。
  it('eval に式が 2 つ以上あれば終了コード 2', () => {
    const result = runCommand(['eval', '1 + 1', '2 + 2']);
    expect(result.stdout).toBe('');
    expect(result.exitCode).toBe(2);
  });

  it('--help は使い方を stdout に出して終了コード 0', () => {
    const result = runCommand(['--help']);
    expect(result.stdout).toContain('使い方');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
  });

  it('-h も同じ', () => {
    const short = runCommand(['-h']);
    expect(short.stdout).toContain('使い方');
    expect(short).toEqual(runCommand(['--help']));
  });
});
