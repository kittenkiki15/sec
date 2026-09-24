# sec

Smalltalk 風の言語で数式やマクロを記述できる、Excel 風スプレッドシートの Web アプリ

## ドキュメント

| 文書 | 内容 |
| --- | --- |
| [開発方針](docs/00-development-policy.md) | 進め方、人間と AI の分担、マイルストーン、リスク |
| [要件定義書](docs/01-requirements.md) | 目的・スコープ・機能／非機能要件・未決の設計論点 |
| [言語仕様書](docs/02-language-spec.md) | 数式・マクロ言語の構文と意味論（EBNF）。§1〜7 が確定 |
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

pnpm sec eval '3 + 4 * 2'                                   # → 14
pnpm sec eval '#(1 2 3 4) inject: 0 into: [:a :b | a + b]'  # → 10

# マクロを実行する（M4）。シートは仮の JSON（{"A1": "3", "B1": "=A1 * 2"}）で受け渡す
pnpm sec run sum.st --sheet in.json --out out.json --send 'from: 1 to: 3'

pnpm sec bench  # 性能要件（N-1・N-2）を計測する
pnpm dev        # 10×10 のデモを開く（M3.5）
```

`sec eval` と `sec run` の終了コードは 0（値）/ 1（エラー値・時間切れ）/ 2（使い方の誤り）です。
`sec run` の形は [ADR-0034](docs/adr/0034-sec-run.md) を参照してください。

Node 22.18 以上、pnpm 10 が必要です。`core` と `cli` はビルド段を置かず `node` が `.ts` を
直接読みます。`web` だけは Vite が束ねます（[ADR-0026](docs/adr/0026-web-ui-stack.md)）。

## 現在の状況

**M4（マクロ）まで完了。** 言語仕様書の §1〜7 が確定し、字句解析器・構文解析器・評価器・
シートモデル・依存グラフに基づく増分再計算に加えて、マクロの実行が入りました。
マクロは一時変数・文の列・セルへの書き込みを持ち、1 回の実行が 1 つのトランザクションになります。
ステップ数（100 万）・再帰深度（256）・時間（CLI は既定 5 秒）に上限があります。
ゴールデンテスト `tests/golden/*.txt` は 14 ファイル 854 件がすべて緑です。

`pnpm dev` で 10×10 のグリッド（M3.5 のデモ）が開き、数式を入れると下流が計算し直されます。

**次は M5（MCP サーバー）です。** 詳しくは [次の一歩](docs/NEXT.md) を参照してください。
