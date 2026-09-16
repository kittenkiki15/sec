/**
 * `sec` を実際に起動して、`runCommand` の結果が process にどう出るかを確かめる。
 *
 * **`command.test.ts` が振る舞いを、こちらが配線を見る。** 出力先の取り違えや
 * 終了コードの落とし忘れは、純粋な関数のテストでは捕まらない。
 */

import { execFileSync } from 'node:child_process';
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
});
