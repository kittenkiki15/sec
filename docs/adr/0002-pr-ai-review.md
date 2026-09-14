# ADR-0002: PR 自動レビューは Actions から OpenAI API を直接呼ぶ

- 状態: accepted
- 日付: 2026-09-14

## 背景

レビュアーのいない 1 人開発を補うため、PR に自動レビューを掛けたい。
使用モデルは GPT-5.6 Terra（`gpt-5.6-terra`）を指定したい。

## 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A | GitHub 組み込みの Copilot code review | 保守不要 | **使用モデルを選べない。** モデル選択ができるのは PR コメントで `@copilot` にメンションしたときのみで、自動実行ではない |
| B | GitHub Models 推論 API を Actions から呼ぶ | `GITHUB_TOKEN` だけで動き、API キー管理と従量課金が不要 | `gpt-5.6-terra` がカタログにあるか不確実 |
| C | OpenAI API を Actions から直接呼ぶ | モデルを確実に指定できる | API キーの管理が必要。従量課金 |

## 決定

**C を採用する。** モデル指定が要件であり、それを確実に満たせるのは C だけ。

実装は `.github/workflows/ai-review.yml` と `.github/scripts/ai-review.mjs`。
レビューの観点は `.github/ai-review-guidelines.md` に分離し、プロンプトに埋め込む。
運用は `docs/03-ai-review.md`。

## 影響

- リポジトリに `OPENAI_API_KEY` シークレットが必要。
- **PR のタイトル・本文・差分が OpenAI に送信される。** 公開できない情報を置かない。
- PR 本文経由のプロンプトインジェクションは原理的に防げないため、
  ワークフローの権限を `contents: read` と `pull-requests: write` に絞り、
  イベントは常に `COMMENT` とする。**承認もマージもさせない。**
- フォークからの PR では動かない（シークレットが渡らないため）。
  ~~外部からの貢献を受けるようになったら `pull_request_target` は使わず、
  メンテナによる手動実行（`workflow_dispatch`）で運用する。~~
  **この記述は [ADR-0005](0005-ai-review-trigger.md) で訂正した。**
  フォークからの貢献だけを想定しており、同一リポジトリの PR からシークレットを
  抜き取れる経路を扱っていなかった。起動イベントは `pull_request_target` に変更した。

## 覆すとしたら

- GitHub Models のカタログに `gpt-5.6-terra` が入り、レートと品質が実用に足るとき → B に移す
- Copilot code review がモデル選択に対応したとき → A に戻して保守対象を減らす
