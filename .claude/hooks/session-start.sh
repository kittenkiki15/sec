#!/bin/bash
# Claude Code のセッション開始時に依存関係を用意する。
# これが無いと、リモートセッションのたびに pnpm install から始めることになる。
set -euo pipefail

# ローカルの開発環境では何もしない。手元の node_modules を勝手に触らないため。
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# コミットの名義をリポジトリの中だけで固定する。
# 環境側の既定に任せていた頃、アカウントに登録されたメールアドレスで
# 記録された履歴が残った。GitHub はアドレスで著者を引き当てるため、
# そのアドレスを持つアカウントに紐づいてしまう。
git config --local user.name "Claude"
git config --local user.email "noreply@anthropic.com"

# pnpm が無ければ corepack で package.json の packageManager に合わせて用意する。
if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm が見つからないため corepack で有効化します。"
  corepack enable pnpm
fi

echo "pnpm $(pnpm --version) で依存関係をインストールします。"
pnpm install

echo "セットアップ完了。pnpm check で型検査・Lint・テストをまとめて実行できます。"
