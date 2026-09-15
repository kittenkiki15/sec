# ADR-0014: 添字が範囲外のときは `#SubscriptOutOfBounds` とし、F-8-2 に足す

- 状態: accepted
- 日付: 2026-09-14
- 関連: 要件 F-8-2、F-2-13、[ADR-0013](0013-non-finite-numbers.md)、仕様書 §0.3、§6.0、§6.2

## 背景

§6.2 で `copyFrom:to:` を定めるにあたり、**添字が範囲外のとき何を返すかを決める必要が
あった。** `'abc' copyFrom: 1 to: 5` のような式である。

F-8-2 のエラー種別（ADR-0013 で 8 種になった）に、添字の誤りに当たるものが無い。
`#TypeError` で代用する案もあったが、**利用者から「`#TypeError` とは別のシンボルにし、
Smalltalk の標準的な例外の名称に寄せたい」という指示があった。**

## Smalltalk での名称

**単一の標準名は無く、方言で分かれる。**

| 方言 | 名称 |
| --- | --- |
| Smalltalk-80（Blue Book） | エラー送出メソッドが `Object>>errorSubscriptBounds:` |
| Squeak / Pharo | `SubscriptOutOfBounds`（`Error` のサブクラス） |
| GNU Smalltalk | `SystemExceptions.IndexOutOfRange` |

## 選択肢

| 案 | 内容 | 利点 | 欠点 |
| --- | --- | --- | --- |
| A | `#TypeError` で代用する | 種別が増えない | 「型の誤り」で添字の誤りを表すことになり、原因が伝わらない |
| B | **`#SubscriptOutOfBounds` を足す** | Smalltalk-80 の直系（Squeak / Pharo）の名前で、`errorSubscriptBounds:` から辿れる | 要件定義書の変更を伴う。種別名が長い |
| C | `#IndexOutOfRange` を足す | 短く、他言語の利用者にも通じやすい | GNU Smalltalk 系の名前で、Smalltalk-80 の直系ではない |

## 決定

**B を採用する**（利用者の指示による）。

- **添字が範囲外のときは `#SubscriptOutOfBounds` を返す**
- **F-8-2 のエラー種別に足し、9 種とする**

Squeak / Pharo 系を採ったのは、**Smalltalk-80 の直系**であり Blue Book の
`errorSubscriptBounds:` から素直に辿れるためである。長さは許容した。既に
**`#DoesNotUnderstand` が Smalltalk の `doesNotUnderstand:` をそのまま採った前例**であり、
命名の揃え方として一貫する。

### 添字は 1 起点

`copyFrom:to:` や `indexOf:` の添字は **1 起点**とする。Smalltalk-80 と Excel の
どちらもそうであり、選択の余地が無い。したがって **`0` は常に範囲外**である。

### 検査の順序における位置

§6.0 の検査の順序で、**添字の範囲は「演算が定義されるか」の段階に入る**。
ゼロ除算と同じ水準であり、引数の型検査より後、結果を表せるかの検査より前になる。

```smalltalk
'abc' copyFrom: 'x' to: 99   "→ #TypeError。型が先"
'abc' copyFrom: 1 to: 99     "→ #SubscriptOutOfBounds"
```

## 影響

- **要件定義書 F-8-2 を変更する。** エラー種別が 8 種から 9 種になる
  （ADR-0013 に続いて 2 度目）
- §0.3 のエラー種別の列挙と、§6.0 の検査の順序の表を更新する
- §6.3（PR C）の `Array` の添字にも同じ種別を使う。`at:` を入れるならそこで効く
- 評価器は、添字を取るセレクタで範囲検査を行う必要がある

## 覆すとしたら

- 名前が長すぎて実用に耐えないと判明したとき → `#Subscript` への短縮を検討する。
  **種別を増やすのではなく名前を変える**（ADR-0013 と同じ方針）
- Excel 互換の別名関数（F-2-14）を入れる際に、Excel の `#VALUE!` との対応付けが
  問題になったとき
