import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      // web のテストは JSX を含む（ADR-0026）。DOM が要るファイルは先頭の
      // `// @vitest-environment happy-dom` で環境を指定する。
      'packages/*/src/**/*.test.tsx',
      'tests/**/*.test.mjs',
      '.github/scripts/**/*.test.mjs',
      '.claude/hooks/**/*.test.mjs',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: [
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.tsx',
        // 起動の口は DOM に差し込むだけで振る舞いを持たない。ここを数えると、
        // テストのために `document` を触る層を足すことになる（ADR-0026 の依存方向）。
        'packages/web/src/main.tsx',
      ],
      reporter: ['text', 'lcov'],
      // 要件 N-8 / 受け入れ基準 5: 計算コアのカバレッジは行 80% 以上
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
