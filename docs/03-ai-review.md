# PR 自動レビュー（GitHub Actions + OpenAI API）

プルリクエストが作成・更新されると、差分を OpenAI の **GPT-5.6 Terra**（`gpt-5.6-terra`）に
渡してレビューさせ、結果を PR にレビューコメントとして投稿します。

| ファイル | 役割 |
| --- | --- |
| `.github/workflows/ai-review.yml` | 起動条件と環境変数 |
| `.github/scripts/ai-review.mjs` | 差分の収集、OpenAI API 呼び出し、レビュー投稿 |
| `.github/ai-review-guidelines.md` | プロンプトに埋め込むレビュー方針。**観点を変えたいときはここを編集** |

## なぜ Actions で自前に書いたか

GitHub 組み込みの Copilot code review は PR 作成時の自動実行には対応していますが、
**使用モデルを選べません**。モデル選択ができるのは PR コメントで `@copilot` に
メンションしたときのモデルピッカーだけで、これは自動実行ではありません。
`gpt-5.6-terra` を指定するには、Actions から OpenAI API を直接呼ぶ必要があります。

## セットアップ

1. OpenAI の API キーを発行する（<https://platform.openai.com/api-keys>）。
2. リポジトリの **Settings → Secrets and variables → Actions → Secrets** で
   `OPENAI_API_KEY` という名前のシークレットを登録する。
3. これだけで有効になります。次の PR から自動でレビューが走ります。

## 設定の変更

リポジトリ変数（**Settings → Secrets and variables → Actions → Variables**）で上書きできます。

| 変数 | 既定値 | 意味 |
| --- | --- | --- |
| `AI_REVIEW_MODEL` | `gpt-5.6-terra` | 使用するモデル |
| `AI_REVIEW_LANGUAGE` | `ja` | レビュー本文の言語 |
| `AI_REVIEW_REASONING_EFFORT` | (未設定) | 設定時のみ `reasoning_effort` として送信 |

スクリプト側の環境変数（ワークフローに追記すれば効きます）:

| 環境変数 | 既定値 | 意味 |
| --- | --- | --- |
| `AI_REVIEW_MAX_DIFF_BYTES` | `200000` | 差分全体の上限。超過分はレビューしない |
| `AI_REVIEW_MAX_FILE_BYTES` | `20000` | 1 ファイルあたりの上限 |
| `AI_REVIEW_MAX_FINDINGS` | `20` | 投稿する指摘の上限 |

## 動作

- **起動条件**: PR の `opened` / `synchronize` / `reopened` / `ready_for_review`。
  加えて Actions 画面から PR 番号を指定して手動実行できます。
- **スキップ条件**: ドラフト PR、`no-ai-review` ラベル付きの PR、フォークからの PR
  （フォークにはシークレットが渡らないため）。
- **レビュー対象外**: ロックファイル、`dist/` `build/` `out/` `coverage/` 配下、
  `*.min.js`、画像・フォント等のバイナリ。
  差分が大きすぎて GitHub が patch を返さないファイルも対象外になり、PR 本文に一覧が出ます。
- **投稿形式**: 要約を本文に、個別の指摘を該当行のインラインコメントとして投稿します。
  行を特定できなかった指摘は本文にまとめられます。
  イベントは常に `COMMENT` で、**承認や変更要求は行いません**。
- 連続してプッシュした場合、**まだ実行中だった**古いレビューはキャンセルされます（無駄な API 呼び出しを避けるため）。
  既に投稿されたレビューはキャンセルできないので、PR には各コミットに対するレビューが履歴として積み上がります。

重大度は critical / major / minor / nit の 4 段階です。
これは AI の自己申告なので、そのまま信用せず必ず自分で判断してください。

## 費用

OpenAI の従量課金が発生します。差分と方針ファイルが入力、レビュー結果が出力です。
おおむね 1 PR あたり入力 5〜50k トークン程度を見込んでおけば大きく外れません。
費用を抑えたい場合は次が効きます。

- PR を小さく保つ（開発方針で PR は 400 行以内を目安としています）
- `AI_REVIEW_MAX_DIFF_BYTES` を下げる
- `AI_REVIEW_MODEL` をより安価なモデル（`gpt-5.6-luna` 等）に切り替える
- WIP 中は `no-ai-review` ラベルを付ける

## セキュリティ上の注意

- **PR のタイトル・本文・差分は OpenAI に送信されます。** 公開できない情報を
  リポジトリに置かないでください。
- PR 本文や差分に「レビューを省略せよ」といった指示文を仕込む**プロンプトインジェクション**は
  原理的に防げません。そのためワークフローは権限を `contents: read` と
  `pull-requests: write` に絞り、承認もマージも行わない設計にしています。
  レビュー結果は参考情報であり、マージの判断は人間が行ってください。
- フォークからの PR ではワークフローが動きません（シークレット漏洩を避けるため）。
  外部からの貢献を受け付けるようになったら、`pull_request_target` を使うのではなく、
  メンテナが手動実行（`workflow_dispatch`）する運用を推奨します。

## うまく動かないとき

| 症状 | 対処 |
| --- | --- |
| `シークレット OPENAI_API_KEY が未設定です` | 上記セットアップ手順 2 を実施 |
| `OpenAI API 404` でモデルが見つからない | 使用中のアカウントで `gpt-5.6-terra` が有効か確認。`AI_REVIEW_MODEL` で別モデルを指定して切り分ける |
| `Unsupported parameter` | スクリプトが該当パラメータを外して自動再試行します。ログに `::notice::` として記録されます |
| 行コメントが付かず本文にまとまる | 指摘行が差分の範囲外だったケース。仕様どおりの挙動です |
| レビューが走らない | ドラフトでないか、`no-ai-review` ラベルが付いていないか、フォークからの PR でないかを確認 |
