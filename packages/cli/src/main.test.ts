/**
 * `sec` を実際に起動して、`runCommand` の結果が process にどう出るかを確かめる。
 *
 * **`command.test.ts` が振る舞いを、こちらが配線を見る。** 出力先の取り違えや
 * 終了コードの落とし忘れは、純粋な関数のテストでは捕まらない。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

/** `sec` を起動する。終了コードが 0 でなくても投げずに返す。 */
function run(...args: string[]): { stdout: string; stderr: string; status: number } {
  try {
    // stderr も受け取る。既定では親の stderr へ素通しになり、テストの出力が汚れる。
    const stdout = execFileSync(process.execPath, [main, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (error) {
    const failure = error as { stdout: string; stderr: string; status: number };
    return { stdout: failure.stdout, stderr: failure.stderr, status: failure.status };
  }
}

describe('sec の起動', () => {
  it('値を stdout に出して 0 で終わる', () => {
    expect(run('eval', '3 + 4 * 2')).toEqual({ stdout: '14\n', stderr: '', status: 0 });
  });

  it('エラー値では 1 で終わる', () => {
    const result = run('eval', '1 / 0');
    expect(result.stdout).toBe('#DivideByZero\n');
    expect(result.status).toBe(1);
  });

  it('構文エラーの診断は stderr へ出る', () => {
    const result = run('eval', '3 +');
    expect(result.stdout).toBe('#Syntax\n');
    expect(result.stderr).toContain('1:4');
    expect(result.status).toBe(1);
  });

  it('使い方の誤りでは 2 で終わる', () => {
    const result = run();
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('使い方');
    expect(result.status).toBe(2);
  });

  // ファイルの読み書きと Worker の起動は、差し替えたホストでは確かめられない。
  it('run はマクロを Worker で走らせ、--out にシートを書く', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-run-'));
    const macro = join(dir, 'm.st');
    const sheet = join(dir, 'in.json');
    const out = join(dir, 'out.json');
    writeFileSync(macro, 'B1 := A1 value * 2. ^ B1');
    writeFileSync(sheet, '{"A1": "21"}');

    expect(run('run', macro, '--sheet', sheet, '--out', out)).toEqual({
      stdout: '42\nB1 := 42\n',
      stderr: '',
      status: 0,
    });
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ A1: '21', B1: '42' });
  });

  it('run は時間の上限を超えたら 1 で終わる', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sec-run-'));
    const macro = join(dir, 'm.st');
    writeFileSync(macro, '[true] whileTrue: [1]');

    const result = run('run', macro, '--timeout', '1');
    expect(result.stdout).toBe('#Timeout\n');
    expect(result.status).toBe(1);
  });
});
