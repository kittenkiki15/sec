/** `sec` の 1 回の実行が生む出力。**process には触れない**ので、そのままテストできる。 */
export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

/** 実装はこれから。 */
export function runCommand(_argv: readonly string[]): CommandResult {
  return { stdout: '', stderr: '', exitCode: 0 };
}
