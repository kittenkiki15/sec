#!/usr/bin/env node
/**
 * マイルストーンのタグ名を検証する。
 *
 * タグは一度 push すると実質的に取り消せないため、作成前にここで弾く。
 * 命名規則は ADR-0006（`m<マイルストーン番号>`、例: m0.5 / m1 / m3.5）。
 *
 * 使い方: node .github/scripts/validate-milestone-tag.mjs "m0.5"
 */

import { fileURLToPath } from 'node:url';

/** 先頭ゼロを禁止する。m01 と m1 が別のタグとして並ぶのを避けるため。 */
const MILESTONE_TAG = /^m(0|[1-9]\d*)(\.(0|[1-9]\d*))?$/;

const EXAMPLE = '正しい形式の例: m0.5 / m1 / m3.5';

/**
 * @param {unknown} tag 検証するタグ名
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateMilestoneTag(tag) {
  if (typeof tag !== 'string') {
    return { ok: false, reason: `タグ名が文字列ではありません。${EXAMPLE}` };
  }
  if (tag.trim() === '') {
    return { ok: false, reason: `タグ名が空です。${EXAMPLE}` };
  }
  // 空白は黙って取り除かない。打ちたかった名前と実際のタグが食い違うため。
  if (tag !== tag.trim()) {
    return { ok: false, reason: `タグ名の前後に空白があります。${EXAMPLE}` };
  }
  if (/^m0\d|\.0\d/.test(tag)) {
    return {
      ok: false,
      reason: `番号の先頭に 0 は付けられません（m01 と m1 が別物として並ぶため）。${EXAMPLE}`,
    };
  }
  if (!MILESTONE_TAG.test(tag)) {
    return { ok: false, reason: `タグ名の形式が規則に合いません。${EXAMPLE}` };
  }
  return { ok: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = validateMilestoneTag(process.argv[2]);
  if (!result.ok) {
    console.error(`::error::${result.reason}（指定された値: ${JSON.stringify(process.argv[2])}）`);
    process.exit(1);
  }
  console.log(`タグ名 ${process.argv[2]} は規則に適合しています。`);
}
