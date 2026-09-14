#!/usr/bin/env node
/**
 * タグと Release の現在の状態から、何を作るべきかを決める。
 *
 * タグの push は Release 作成より先に完了するため、Release 作成だけが失敗すると
 * 「タグはあるが Release が無い」状態が残る。既存タグを一律に拒否すると、この状態から
 * ワークフローで復旧できなくなる（ADR-0006）。
 *
 * かといって既存タグを黙って受け入れると、打ち間違いで既存のタグ名を指定したときに
 * 意図しないコミットへ Release が付いてしまう。そのため復旧は明示的な入力
 * （allow_existing_tag）でのみ許す。
 *
 * 使い方:
 *   TAG_EXISTS=true RELEASE_EXISTS=false ALLOW_EXISTING_TAG=true \
 *     node .github/scripts/decide-tag-action.mjs
 */

import { fileURLToPath } from 'node:url';

/**
 * @param {{ tagExists: boolean, releaseExists: boolean, allowExistingTag: boolean }} state
 * @returns {{ action: 'create-tag-and-release' | 'create-release-only' } | { action: 'fail', reason: string }}
 */
export function decideTagAction({ tagExists, releaseExists, allowExistingTag }) {
  if (!tagExists) {
    if (releaseExists) {
      return {
        action: 'fail',
        reason: 'タグが無いのに Release だけが存在します。状態を確認してください。',
      };
    }
    return { action: 'create-tag-and-release' };
  }

  if (!allowExistingTag) {
    return {
      action: 'fail',
      reason:
        'タグは既に存在します。別の名前を指定してください。' +
        'タグは作成できたが Release の作成だけが失敗した状態から復旧したい場合は、' +
        'allow_existing_tag を true にして再実行してください（タグは作り直されません）。',
    };
  }

  if (releaseExists) {
    return {
      action: 'fail',
      reason: 'タグと Release の両方が既に存在します。作るものがありません。',
    };
  }

  return { action: 'create-release-only' };
}

const asBool = (value) => value === 'true';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = decideTagAction({
    tagExists: asBool(process.env.TAG_EXISTS),
    releaseExists: asBool(process.env.RELEASE_EXISTS),
    allowExistingTag: asBool(process.env.ALLOW_EXISTING_TAG),
  });

  if (result.action === 'fail') {
    console.error(`::error::${result.reason}`);
    process.exit(1);
  }
  console.log(result.action);
}
