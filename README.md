# sec

Smalltalk 風の言語で数式やマクロを記述できる、Excel 風スプレッドシートの Web アプリ

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [開発方針](docs/00-development-policy.md) | 進め方、人間と AI の分担、マイルストーン、リスク |
| [要件定義書](docs/01-requirements.md) | 目的・スコープ・機能／非機能要件・未決の設計論点 |
| [PR 自動レビュー](docs/03-ai-review.md) | GitHub Actions から OpenAI API を呼ぶ自動レビューの設定と運用 |
| [設計判断の記録](docs/adr/) | ADR。仕様に関わる判断は必ずここを確認してから |
| [ADR-0004 テスト駆動開発](docs/adr/0004-tdd.md) | 本プロジェクトはテスト駆動開発で進める |
| [CLAUDE.md](CLAUDE.md) | Claude Code 向けの作業規約 |
| [次の一歩](docs/NEXT.md) | 現在地と次にやること |

## 開発

```bash
pnpm install
pnpm check      # 型検査 + Lint + テスト
pnpm test:watch # テストを監視実行
```

Node 22 以上、pnpm 10 が必要です。

## 現在の状況

要件定義フェーズ。M0.5（リポジトリ基盤）まで完了し、言語仕様の確定（M0）が次の作業です。
計算コアの実装はまだ始まっていません。
