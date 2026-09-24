#!/usr/bin/env node
/**
 * `sec` の入口。**process に触れるのはこのファイルだけ**で、配線しか持たない。
 *
 * 判断は `runCommand` にある。分けてあるのは、出力先と終了コードを値として
 * 確かめられるようにするためで、こちらは起動して初めて分かることだけを見る。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { runCommand } from './command.ts';
import { runMacroInWorker } from './worker-host.ts';

const result = await runCommand(process.argv.slice(2), {
  readText: (path) => readFileSync(path, 'utf8'),
  writeText: (path, text) => writeFileSync(path, text),
  runMacro: runMacroInWorker,
});

if (result.stdout !== '') process.stdout.write(result.stdout);
if (result.stderr !== '') process.stderr.write(result.stderr);

// **process.exit ではなく exitCode に入れる。** 出力が書き切られる前に落とさない。
process.exitCode = result.exitCode;
