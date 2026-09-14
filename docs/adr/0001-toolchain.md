# ADR-0001: ツールチェーンの選定

- 状態: accepted
- 日付: 2026-09-14

## 背景

M0.5（リポジトリ基盤）にあたり、パッケージ管理・型検査・テスト・Lint の構成を決める必要がある。
前提は、開発者 1 人 + Claude Code、バックエンドなしの TypeScript プロジェクト、
計算コアは Node 上で単体テストできること（要件 N-8）。

## 決定

| 領域 | 採用 | 理由 |
| --- | --- | --- |
| パッケージ管理 | pnpm workspaces | モノレポを標準機能で扱える。`packageManager` フィールドで版を固定 |
| 言語 | TypeScript（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`） | パーサや評価器は型の恩恵が大きい。境界値の取りこぼしを型で防ぐ |
| テスト | Vitest | 設定がほぼ不要で速い。カバレッジは `@vitest/coverage-v8` |
| Lint / フォーマット | Biome | Lint と整形が 1 ツールで完結し、設定ファイルが 1 つで済む。1 人開発では管理対象を減らす方が効く |
| 実行環境 | Node 22 以上 | 標準の `fetch` と型ストリッピングが使える |

ビルド出力は当面持たない。型検査は `tsc --noEmit`、テストは Vitest が変換するため、
`tsc` に成果物を吐かせる必要がない。`web` を作る段階で Vite のビルドを足す。

## 影響

- **`packages/core/tsconfig.json` は `lib: ["ES2023"]`, `types: []` とする。**
  DOM も `@types/node` も読み込まないため、`window` や `process` を書くと型エラーになる。
  これは要件 N-8（core は DOM 非依存）を型で強制するための防壁であり、緩めない。
- パッケージを追加したら、ルート `package.json` の `typecheck` スクリプトに
  その `tsconfig.json` を足す。
- import は `.ts` 拡張子付きで書く（`allowImportingTsExtensions`）。
  Vite / Vitest でも Node の型ストリッピングでも動く。

## 覆すとしたら

- Biome が TypeScript の型情報を要する規則に対応できず、型を見た Lint が必要になったとき
  → ESLint + typescript-eslint に戻す
- モノレポのパッケージ間で型の再利用が重くなったとき → TypeScript のプロジェクト参照を導入する
