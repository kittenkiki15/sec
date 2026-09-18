import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'tests/**/*.test.mjs',
      '.github/scripts/**/*.test.mjs',
      '.claude/hooks/**/*.test.mjs',
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['packages/*/src/**/*.test.ts'],
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
