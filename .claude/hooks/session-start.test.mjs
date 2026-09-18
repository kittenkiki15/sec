import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const hook = join(dirname(fileURLToPath(import.meta.url)), 'session-start.sh');

let workspace;

/** hook が呼んだ pnpm を記録するスタブ。実際の install は数十秒かかるため走らせない。 */
function makeStubs(dir) {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const log = join(dir, 'pnpm.log');
  writeFileSync(
    join(bin, 'pnpm'),
    `#!/bin/bash\nif [ "$1" = "--version" ]; then echo 10.33.0; else echo "$@" >> ${log}; fi\n`,
  );
  chmodSync(join(bin, 'pnpm'), 0o755);
  return { bin, log };
}

function run(env) {
  const { bin } = makeStubs(workspace);
  execFileSync('bash', [hook], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: workspace,
      CLAUDE_PROJECT_DIR: workspace,
      ...env,
    },
    stdio: 'pipe',
  });
}

function localConfig(key) {
  return execFileSync('git', ['config', '--local', '--get', key], {
    cwd: workspace,
    encoding: 'utf8',
  }).trim();
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'session-start-'));
  execFileSync('git', ['init', '-q'], { cwd: workspace });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('session-start hook', () => {
  it('リモートセッションではコミットの名義を Claude に固定する', () => {
    run({ CLAUDE_CODE_REMOTE: 'true' });

    // 環境側の既定に任せると、アカウント由来のアドレスで記録された履歴が残る。
    expect(localConfig('user.name')).toBe('Claude');
    expect(localConfig('user.email')).toBe('noreply@anthropic.com');
  });

  it('名義の固定はリポジトリの中だけに効かせる', () => {
    run({ CLAUDE_CODE_REMOTE: 'true' });

    // --global に書くとコンテナ全体の設定を書き換えることになる。
    expect(existsSync(join(workspace, '.gitconfig'))).toBe(false);
  });

  it('リモートセッションでは依存関係を用意する', () => {
    run({ CLAUDE_CODE_REMOTE: 'true' });

    expect(readFileSync(join(workspace, 'pnpm.log'), 'utf8')).toContain('install');
  });

  it('手元の環境では何もしない', () => {
    run({});

    // 手元の設定を勝手に書き換えないため、名義にも触らない。
    expect(() => localConfig('user.email')).toThrow();
    expect(existsSync(join(workspace, 'pnpm.log'))).toBe(false);
  });
});
