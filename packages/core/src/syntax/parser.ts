/**
 * 構文解析器。字句解析器が返すトークンの列から AST を組む。
 *
 * **開始記号は 3 つある**（仕様書 §7.1）。`parseFormula` が数式、`parseMacroBody` と
 * `parseMacroDefinition` がマクロで、**字句も式もセレクタも共通で、違うのは構文だけである。**
 * 数式は副作用を持てないため（要件 F-2-10）、代入・文区切り・返却・一時変数の宣言は
 * `parseFormula` が `#Syntax` として弾く。**数式が拒む範囲を構文の 1 箇所で決める**（§7.3）。
 *
 * **名前の静的検査もここで行う**（§7.3、§7.5）。宣言の無い識別子への代入、引数への代入、
 * 二重の宣言、外側の名前を影にする宣言はいずれも `#Syntax` である。
 * **検査は開始記号で変えない。** 数式で宣言できる名前はブロック引数だけなので、
 * 数式に現れるのは引数どうしの重なりに限られる（§5.1）。
 *
 * 木を組むときに次の 3 つを行う。字句解析器はトークンを原文のまま持たせている。
 *
 * - 数値・文字列・シンボルを値へ変換する（`007` → `7`、`1e3` → `1000`）
 * - 範囲の糖衣を `to:` の送信へ脱糖する（§4.3。**範囲専用のノードは作らない**）
 * - 倍精度に収まらない小数のリテラルを `#Overflow` にする（§2.1、ADR-0013）
 */

import { type Token, type TokenKind, tokenize } from './lexer.ts';

/** 整数。桁数に上限が無いため任意精度で持つ（ADR-0012）。 */
export interface IntegerNode {
  readonly kind: 'integer';
  readonly value: bigint;
}

/** 小数。IEEE754 倍精度（ADR-0012）。 */
export interface DecimalNode {
  readonly kind: 'decimal';
  readonly value: number;
}

/** 文字列。引用符を外し、二重の `''` を 1 つに戻した中身を持つ。 */
export interface StringNode {
  readonly kind: 'string';
  readonly value: string;
}

/** シンボル。`#` を外した綴りを持つ（`#at:put:` なら `at:put:`）。 */
export interface SymbolNode {
  readonly kind: 'symbol';
  readonly value: string;
}

export interface BooleanNode {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface NilNode {
  readonly kind: 'nil';
}

/** リテラル配列。要素はリテラルだけで、式は書けない（§2.4）。 */
export interface ArrayNode {
  readonly kind: 'array';
  readonly elements: readonly LiteralNode[];
}

/**
 * 値としてのエラー（§3.7）。**構文解析の段階で生じるのは `#Overflow` だけ。**
 * 倍精度に収まらない小数のリテラルがこれになる（§2.1、ADR-0013）。
 * 構文エラーではないので `ParseError` にはしない。木に載せて評価器へ渡す。
 */
export interface ErrorNode {
  readonly kind: 'error';
  readonly error: 'Overflow';
}

/** 裸の識別子。名前付き範囲が入るまでは評価すると `#Ref`（§4.2）。 */
export interface IdentifierNode {
  readonly kind: 'identifier';
  readonly name: string;
}

/**
 * セル参照。**原文の綴りをそのまま持つ**（`A1`、`AB12`）。
 * 列と行への分解はシートの側の仕事で、構文にはその区別が要らない。
 */
export interface CellNode {
  readonly kind: 'cell';
  readonly name: string;
}

/**
 * 一時変数の宣言と文の列。**マクロの本体（§7.2）とブロックの本体（§7.5）が同じ形を持つ。**
 * 数式のブロックはその退化した場合で、`temporaries` が空、`statements` が式 1 つになる。
 * **評価器がブロックを 1 種類だけ見れば済む**ように、開始記号でノードを分けていない。
 */
export interface Body {
  readonly temporaries: readonly string[];
  readonly statements: readonly Statement[];
}

/** ブロック。引数は 0〜2 個（要件 F-2-5、§5.1）。 */
export interface BlockNode extends Body {
  readonly kind: 'block';
  readonly parameters: readonly string[];
}

/**
 * 代入。**式ではなく文である**（§7.3）。左辺になれるのは宣言済みの一時変数と
 * セル参照だけで（§7.4）、値を持たない。
 */
export interface AssignNode {
  readonly kind: 'assign';
  readonly target: IdentifierNode | CellNode;
  readonly value: Expression;
}

/**
 * 返却。**文の列の最後の文としてだけ書ける**（§7.2）。
 * ブロックの中に現れたものは非局所リターンで、マクロ全体を終える（§7.5）。
 */
export interface ReturnNode {
  readonly kind: 'return';
  readonly value: Expression;
}

/** マクロの定義。開始記号 `macro definition`（§7.1）。 */
export interface MacroDefinition {
  /** 単項セレクタか、連結したキーワードパターン（`from:to:`）。 */
  readonly selector: string;
  readonly parameters: readonly string[];
  readonly body: Body;
}

/** メッセージ送信。単項・二項・キーワードの区別は引数の数とセレクタの綴りに現れる。 */
export interface SendNode {
  readonly kind: 'send';
  readonly receiver: Expression;
  readonly selector: string;
  readonly arguments: readonly Expression[];
}

/** リテラル配列の要素になれるもの（§2.4）。 */
export type LiteralNode =
  | IntegerNode
  | DecimalNode
  | StringNode
  | SymbolNode
  | BooleanNode
  | NilNode
  | ArrayNode
  | ErrorNode;

/** 数式の AST のノード。 */
export type Expression = LiteralNode | IdentifierNode | CellNode | BlockNode | SendNode;

/** マクロの文（§7.2）。**代入と返却は式ではない**ので、式の中には現れない。 */
export type Statement = Expression | AssignNode | ReturnNode;

/**
 * 構文解析の段階で分かる構文エラー（要件 F-8-2 の `#Syntax`）。
 * 位置と説明文を持たせるのは要件 F-8-3 のため。字句の段階の分は `LexicalError`。
 * **どちらで見つかっても利用者に見えるのは `#Syntax`** で、位置と文言はゴールデンテストの
 * 期待値には現れない（§0.3）。
 */
export class ParseError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.column = column;
  }
}

/** 開始記号の別（§7.1）。マクロの 2 つは、宣言部の有無しか違わないので区別しない。 */
type Start = 'formula' | 'macro';

/**
 * 数式に現れたら `#Syntax` になるトークン（要件 F-2-10）。
 * いずれもマクロの文法にだけ現れる（§7.2、§7.3）。**現れた理由を言う方が直しやすい**ので、
 * 「ここに書けません」ではなく数式とマクロの境界を説明する文言にしている。
 */
const MACRO_ONLY: ReadonlyMap<TokenKind, string> = new Map<TokenKind, string>([
  ['assign', '代入 ":=" は数式に書けません。数式は副作用を持てません（要件 F-2-10、§7.3）。'],
  ['period', '文区切り "." は数式に書けません。数式の本体は式ちょうど 1 つです（§3.1）。'],
  ['caret', '返却 "^" は数式に書けません。数式の本体は式ちょうど 1 つです（§3.1）。'],
]);

/**
 * マクロでも式の中には現れないトークン。**マクロが拒むのは位置であって構文ではない**ので、
 * 数式の側（`MACRO_ONLY`）とは理由が違う。
 */
const STATEMENT_ONLY: ReadonlyMap<TokenKind, string> = new Map<TokenKind, string>([
  [
    'assign',
    '代入 ":=" は文であって式ではありません。左辺になれるのは宣言済みの一時変数と' +
      'セル参照だけです（§7.3）。',
  ],
  ['period', '文区切り "." は式の中に書けません。文の切れ目にだけ置けます（§7.2）。'],
  ['caret', '返却 "^" は文の先頭にだけ書けます（§7.2）。'],
]);

/** §4.3 の範囲トークンの区切り。どちらで書いても `to:` へ脱糖する。 */
const RANGE_DELIMITER = /\.\.|:/;

/** 宣言された名前の役割。**引数は代入の左辺になれない**（§7.3）。 */
type Role = 'temporary' | 'parameter';

/** 本体にもブロックにも文が 1 つ以上要る（§7.2、§5.1 の `[]` と同じ扱い）。 */
const EMPTY_BODY = '本体には文が 1 つ以上要ります（§7.2、§5.1）。';

/** ブロックの引数の並びを閉じる `|`。二項セレクタと同じ綴りで、位置で区別する（§5.1）。 */
const isBar = (token: Token | undefined): boolean =>
  token !== undefined && token.kind === 'binary' && token.text === '|';

/** `'It''s'` → `It's`。引用符を外し、二重にした引用符を 1 つに戻す（§2.2）。 */
const unquote = (text: string): string => text.slice(1, -1).replaceAll("''", "'");

/**
 * 2 つのトークンが原文で隣り合っているか（間に空白もコメントも無いか）。
 * キーワードセレクタは ASCII に限られる（§1.2）ので、長さは列の差でそのまま測れる。
 */
const adjoins = (left: Token, right: Token): boolean =>
  left.line === right.line && left.column + left.text.length === right.column;

/** 整数のリテラルの値。指数は仮数の種別を変えない（§2.1）ので、`1e3` もここに来る。 */
const integerValue = (text: string): bigint => {
  const [mantissa = '', exponent] = text.split('e');
  const digits = BigInt(mantissa);
  return exponent === undefined ? digits : digits * 10n ** BigInt(exponent);
};

const numberNode = (token: Token): IntegerNode | DecimalNode | ErrorNode => {
  if (token.kind === 'integer') return { kind: 'integer', value: integerValue(token.text) };

  const value = Number(token.text);
  // 非有限値は値として存在しない（ADR-0013）。桁が落ちるだけならエラーにしない。
  if (!Number.isFinite(value)) return { kind: 'error', error: 'Overflow' };
  return { kind: 'decimal', value };
};

const reservedNode = (text: string): BooleanNode | NilNode =>
  text === 'nil' ? { kind: 'nil' } : { kind: 'boolean', value: text === 'true' };

/** `#foo` → `foo`、`#'hello world'` → `hello world`（§2.3）。 */
const symbolNode = (text: string): SymbolNode => {
  const spelling = text.slice(1);
  return { kind: 'symbol', value: spelling.startsWith("'") ? unquote(spelling) : spelling };
};

/**
 * 原文 1 つを読む構文解析器を作る。**開始記号ごとに別の解析器を書かない。**
 * 語彙も式もセレクタも 3 つの開始記号で共通で（§7.1）、違うのは
 * 「文を受けるか」と、拒んだときに言う理由だけである。
 */
const createParser = (source: string, start: Start) => {
  const tokens = tokenize(source);
  let index = 0;

  // 原文の末尾。トークンが尽きた場所を指すために使う（`3 +` の `+` の後ろ）。
  const lines = source.split('\n');
  const end = { line: lines.length, column: [...(lines.at(-1) ?? '')].length + 1 };

  /** 宣言された名前。内側が後ろに積まれる。**影の検査は全体を見る**（§7.5）。 */
  const scopes: Map<string, Role>[] = [];

  const peek = (): Token | undefined => tokens[index];

  const fail = (message: string, token: Token | undefined): never => {
    const at = token ?? end;
    throw new ParseError(message, at.line, at.column);
  };

  /**
   * 範囲の糖衣を書き損ねた形か（§4.3）。字句解析器が範囲トークンにしなかった結果、
   * `A1 .. B10` は文区切り 2 つに、`A1 : B10` はコロンに切られて式の途中に現れる。
   * **「文区切りは数式に書けません」では直せない**ので、位置で見分けて理由を言い換える。
   */
  const looksLikeRange = (token: Token): boolean => {
    if (token !== peek()) return false;
    if (token.kind === 'colon') return tokens[index - 1]?.kind === 'cell';
    return token.kind === 'period' && tokens[index + 1]?.kind === 'period';
  };

  /** 式の中に書けないトークンには、ここに来た理由を言う文言を優先して充てる。 */
  const reason = (token: Token, fallback: string): string => {
    if (looksLikeRange(token)) {
      return (
        '範囲は区切り（".." か ":"）の前後に空白を挟めず、両辺はセル参照でなければ' +
        'なりません（§4.3）。'
      );
    }
    const misplaced = start === 'formula' ? MACRO_ONLY : STATEMENT_ONLY;
    return misplaced.get(token.kind) ?? fallback;
  };

  /** いま宣言を受ける有効範囲。**宣言の前に必ず 1 つ積む**ので、積み忘れても壊さないだけの備え。 */
  const innermost = (): Map<string, Role> => {
    const current = scopes.at(-1);
    if (current !== undefined) return current;

    const created = new Map<string, Role>();
    scopes.push(created);
    return created;
  };

  /**
   * 名前を宣言する。**二重の宣言も、外側の名前を影にする宣言も `#Syntax`**（§7.2、§7.5）。
   * 理由が違うので文言を分ける。開始記号では変えない（§5.1）。
   */
  const declare = (token: Token, role: Role): string => {
    const current = innermost();

    if (current.has(token.text)) {
      return fail(`"${token.text}" を二重に宣言しています（§7.2）。`, token);
    }
    if (scopes.some((scope) => scope.has(token.text))) {
      return fail(
        `"${token.text}" は外側で宣言されています。影になった名前は読み手が追えないため、` +
          `内側で同じ名前を宣言できません（§7.5）。`,
        token,
      );
    }

    current.set(token.text, role);
    return token.text;
  };

  /** 代入の左辺になれるか（§7.3）。**セル参照は宣言を要らない**（§7.4）。 */
  const checkAssignable = (token: Token): void => {
    if (token.kind === 'cell') return;

    const scope = scopes.findLast((names) => names.has(token.text));
    if (scope === undefined) {
      fail(
        `"${token.text}" は宣言されていません。宣言の書き忘れを静的に捕まえるため、` +
          `代入の左辺は宣言済みの一時変数かセル参照に限ります（§7.3）。`,
        token,
      );
      return;
    }
    if (scope.get(token.text) === 'parameter') {
      fail(
        `引数 "${token.text}" には代入できません。書き換えるには一時変数を宣言して` +
          `写します（§7.3）。`,
        token,
      );
    }
  };

  /** リテラル配列の中身。開き括弧は読んだ後に呼ぶ。 */
  const parseArrayElements = (): ArrayNode => {
    const elements: LiteralNode[] = [];

    for (;;) {
      const token = peek();
      if (token === undefined) {
        return fail('リテラル配列が閉じていません。要素の並びは ")" で閉じます（§2.4）。', token);
      }
      if (token.kind === 'rightParen') {
        index += 1;
        return { kind: 'array', elements };
      }
      elements.push(parseArrayElement(token));
    }
  };

  const parseArrayElement = (token: Token): LiteralNode => {
    index += 1;

    switch (token.kind) {
      case 'integer':
      case 'decimal':
        return numberNode(token);
      case 'string':
        return { kind: 'string', value: unquote(token.text) };
      case 'symbol':
        return symbolNode(token.text);
      case 'reserved':
        return reservedNode(token.text);
      // `#` を省いた識別子と二項セレクタはシンボルになる（§2.4 の bare symbol）。
      case 'identifier':
      case 'binary':
        return { kind: 'symbol', value: token.text };
      // キーワードは 1 つずつ切り出されるので、**隣り合っている間だけ**連ねて
      // 1 つのセレクタに戻す（`#(at:put:)` は `#at:put:`、`#(at: put:)` は 2 要素）。
      // 走査が文字を追う Smalltalk の実装と同じ切れ方で、`#(12)` と `#(1 2)` の
      // 区別（§2.4）と同じ性質でもある。
      case 'keyword': {
        let last = token;
        let spelling = token.text;
        for (let next = peek(); next?.kind === 'keyword' && adjoins(last, next); next = peek()) {
          spelling += next.text;
          last = next;
          index += 1;
        }
        return { kind: 'symbol', value: spelling };
      }
      // 入れ子の配列は `#` を省ける（§2.4）。
      case 'arrayStart':
      case 'leftParen':
        return parseArrayElements();
      default:
        return fail(
          reason(
            token,
            `"${token.text}" はリテラル配列の要素になれません。要素はリテラルだけで、` +
              `式は書けません（§2.4）。`,
          ),
          token,
        );
    }
  };

  /** 一時変数の宣言（§7.2）。**本体とブロックの先頭にだけ置ける。** */
  const parseTemporaries = (): string[] => {
    if (!isBar(peek())) return [];
    index += 1;

    const names: string[] = [];
    for (let token = peek(); token?.kind === 'identifier'; token = peek()) {
      names.push(declare(token, 'temporary'));
      index += 1;
    }

    const close = peek();
    if (!isBar(close)) {
      return fail('一時変数の宣言は "|" で閉じます。中には名前だけを並べます（§7.2）。', close);
    }
    index += 1;

    return names;
  };

  /**
   * 文の列（§7.2）。`within` が終わりの見分け方を決める。
   * **終端（原文の終わり／`]`）は読まずに残して返る。**
   */
  const parseStatements = (within: 'body' | 'block'): Statement[] => {
    const closes = (): boolean =>
      within === 'block' ? peek()?.kind === 'rightBracket' : peek() === undefined;

    const statements: Statement[] = [];

    for (;;) {
      if (closes()) {
        if (statements.length === 0) return fail(EMPTY_BODY, peek());
        return statements;
      }
      // 本体は原文の終わりで閉じるので、ここへ来るのはブロックだけ。
      if (peek() === undefined) {
        return fail('ブロックが閉じていません。"[" は "]" で閉じます（§5.1）。', undefined);
      }

      const statement = parseStatement();
      statements.push(statement);

      const token = peek();
      if (token?.kind !== 'period') {
        if (closes()) return statements;
        if (token === undefined) {
          return fail('ブロックが閉じていません。"[" は "]" で閉じます（§5.1）。', token);
        }
        return fail(
          reason(
            token,
            `文の後ろに "${token.text}" が残っています。文は "." で区切ります（§7.2）。`,
          ),
          token,
        );
      }
      index += 1;

      // 末尾の `.` は書いてよいが、`^` の後ろに文は続けられない（§7.2）。
      if (statement.kind === 'return' && !closes()) {
        return fail('"^" は文の列の最後の文です。後ろに文を続けられません（§7.2）。', peek());
      }
    }
  };

  /** 文 1 つ（§7.2）。代入と返却は式ではないので、ここでしか現れない。 */
  const parseStatement = (): Statement => {
    const token = peek();

    if (token?.kind === 'caret') {
      index += 1;
      return { kind: 'return', value: parseExpression() };
    }

    // 左辺になれる綴りに `:=` が続くときだけ代入として読む。`3 := 1` のような形は
    // 式として読み切った後に `:=` が残り、`reason` が理由を言う（§7.3）。
    if (
      (token?.kind === 'identifier' || token?.kind === 'cell') &&
      tokens[index + 1]?.kind === 'assign'
    ) {
      index += 2;
      checkAssignable(token);
      const target: IdentifierNode | CellNode =
        token.kind === 'cell'
          ? { kind: 'cell', name: token.text }
          : { kind: 'identifier', name: token.text };
      return { kind: 'assign', target, value: parseExpression() };
    }

    return parseExpression();
  };

  /** ブロックの引数（§5.1）。並びは `|` で閉じる。 */
  const parseBlockParameters = (): string[] => {
    if (peek()?.kind !== 'colon') return [];

    const names: Token[] = [];
    while (peek()?.kind === 'colon') {
      index += 1;
      const name = peek();
      if (name?.kind !== 'identifier') {
        return fail('ブロックの引数は ":" に続けて識別子を書きます（§5.1）。', name);
      }
      declare(name, 'parameter');
      names.push(name);
      index += 1;
    }

    const bar = peek();
    if (!isBar(bar)) {
      return fail('ブロックの引数の並びは "|" で閉じます（§5.1）。', bar);
    }
    index += 1;

    const third = names[2];
    if (third !== undefined) {
      return fail('ブロックの引数は 0〜2 個です（要件 F-2-5、§5.1）。', third);
    }

    return names.map((token) => token.text);
  };

  /**
   * ブロック。**数式なら本体は式ちょうど 1 つ**（§5.1）、
   * **マクロなら一時変数と文の列を持てる**（§7.5）。引数の並びは共通である。
   */
  const parseBlock = (): BlockNode => {
    index += 1;
    // 引数と一時変数は別の有効範囲に置く。同じ名前なら「影」として理由を言える（§7.5）。
    scopes.push(new Map());
    const parameters = parseBlockParameters();
    scopes.push(new Map());

    const block: BlockNode =
      start === 'formula'
        ? { kind: 'block', parameters, temporaries: [], statements: [parseFormulaBlockBody()] }
        : {
            kind: 'block',
            parameters,
            temporaries: parseTemporaries(),
            statements: parseStatements('block'),
          };

    // 数式の側は本体を読んだ時点で `]` を確かめてある。マクロの側はここで読む。
    if (start !== 'formula') index += 1;
    scopes.pop();
    scopes.pop();

    return block;
  };

  /** 数式のブロックの本体（§5.1）。式ちょうど 1 つで、`]` まで読む。 */
  const parseFormulaBlockBody = (): Expression => {
    const first = peek();
    if (first?.kind === 'rightBracket') {
      return fail('ブロックの本体がありません。本体は式ちょうど 1 つです（§5.1）。', first);
    }
    if (isBar(first)) {
      return fail(
        '数式のブロックは一時変数を宣言できません。本体は式ちょうど 1 つです（§5.1）。',
        first,
      );
    }

    const body = parseExpression();

    const close = peek();
    if (close === undefined) {
      return fail('ブロックが閉じていません。"[" は "]" で閉じます（§5.1）。', close);
    }
    if (close.kind !== 'rightBracket') {
      return fail(reason(close, 'ブロックの本体は式ちょうど 1 つです（§5.1）。'), close);
    }
    index += 1;

    return body;
  };

  const parsePrimary = (): Expression => {
    const token = peek();
    if (token === undefined) {
      return fail('式がありません。数式の本体は式ちょうど 1 つです（§3.1）。', token);
    }

    switch (token.kind) {
      case 'integer':
      case 'decimal':
        index += 1;
        return numberNode(token);
      case 'string':
        index += 1;
        return { kind: 'string', value: unquote(token.text) };
      case 'symbol':
        index += 1;
        return symbolNode(token.text);
      case 'reserved':
        index += 1;
        return reservedNode(token.text);
      case 'identifier':
        index += 1;
        return { kind: 'identifier', name: token.text };
      case 'cell':
        index += 1;
        return { kind: 'cell', name: token.text };
      // 範囲の糖衣は `to:` の送信へ脱糖する（§4.3）。意味論を `to:` の 1 箇所で済ませる。
      case 'range': {
        index += 1;
        const [left = '', right = ''] = token.text.split(RANGE_DELIMITER);
        return {
          kind: 'send',
          receiver: { kind: 'cell', name: left },
          selector: 'to:',
          arguments: [{ kind: 'cell', name: right }],
        };
      }
      case 'arrayStart':
        index += 1;
        return parseArrayElements();
      case 'leftBracket':
        return parseBlock();
      case 'leftParen': {
        index += 1;
        const inner = peek();
        if (inner?.kind === 'rightParen') {
          return fail('空の丸括弧は式ではありません（§3.8）。', inner);
        }

        const expression = parseExpression();
        const close = peek();
        if (close === undefined) {
          return fail('丸括弧が閉じていません。"(" は ")" で閉じます（§3.8）。', close);
        }
        if (close.kind !== 'rightParen') {
          return fail(reason(close, '丸括弧が閉じていません（§3.8）。'), close);
        }
        index += 1;
        return expression;
      }
      case 'binary':
        return fail(
          isBar(token)
            ? start === 'formula'
              ? '一時変数の宣言は数式に書けません。数式の本体は式ちょうど 1 つです（§3.1）。'
              : '一時変数の宣言は本体の先頭にだけ置けます（§7.2）。'
            : `二項セレクタ "${token.text}" に受け手がありません（§3.8）。`,
          token,
        );
      case 'keyword':
        return fail(`キーワード "${token.text}" に受け手がありません（§3.8）。`, token);
      default:
        return fail(reason(token, `"${token.text}" はここに書けません（§3.8）。`), token);
    }
  };

  /** 単項メッセージ。引数を取らず、左から右へ送る（§3.2）。 */
  const parseUnary = (): Expression => {
    let receiver = parsePrimary();

    for (let token = peek(); token?.kind === 'identifier'; token = peek()) {
      index += 1;
      receiver = { kind: 'send', receiver, selector: token.text, arguments: [] };
    }

    return receiver;
  };

  /** 二項メッセージ。**優先順位は無く、左から順に結び付く**（§3.5）。 */
  const parseBinary = (): Expression => {
    let receiver = parseUnary();

    for (let token = peek(); token?.kind === 'binary'; token = peek()) {
      index += 1;
      receiver = { kind: 'send', receiver, selector: token.text, arguments: [parseUnary()] };
    }

    return receiver;
  };

  /**
   * キーワードメッセージ。**複数のキーワードは連結して 1 つのセレクタになる**（§3.4）。
   * セレクタが存在するかは見ない。無ければ評価が `#DoesNotUnderstand` を返す（§3.7）。
   */
  const parseExpression = (): Expression => {
    const receiver = parseBinary();
    if (peek()?.kind !== 'keyword') return receiver;

    let selector = '';
    const args: Expression[] = [];
    for (let token = peek(); token?.kind === 'keyword'; token = peek()) {
      index += 1;
      selector += token.text;
      args.push(parseBinary());
    }

    return { kind: 'send', receiver, selector, arguments: args };
  };

  /** マクロの宣言部（§7.1）。**二項セレクタは認めない。** */
  const parsePattern = (): Pick<MacroDefinition, 'selector' | 'parameters'> => {
    const first = peek();
    if (first?.kind === 'identifier') {
      index += 1;
      return { selector: first.text, parameters: [] };
    }
    if (first?.kind !== 'keyword') {
      return fail(
        'マクロの名前は単項セレクタかキーワードパターンです。二項セレクタは' +
          '認めません（§7.1）。',
        first,
      );
    }

    let selector = '';
    const parameters: string[] = [];
    for (let keyword = peek(); keyword?.kind === 'keyword'; keyword = peek()) {
      index += 1;
      selector += keyword.text;

      const name = peek();
      if (name?.kind !== 'identifier') {
        return fail('キーワードパターンはキーワードごとに引数の名前を取ります（§7.1）。', name);
      }
      parameters.push(declare(name, 'parameter'));
      index += 1;
    }

    return { selector, parameters };
  };

  const formula = (): Expression => {
    const expression = parseExpression();

    const rest = peek();
    if (rest !== undefined) {
      return fail(
        reason(
          rest,
          `式の後ろに "${rest.text}" が残っています。数式の本体は式ちょうど 1 つです（§3.1）。`,
        ),
        rest,
      );
    }

    return expression;
  };

  const macroBody = (): Body => {
    scopes.push(new Map());
    const temporaries = parseTemporaries();
    const statements = parseStatements('body');
    scopes.pop();

    return { temporaries, statements };
  };

  const macroDefinition = (): MacroDefinition => {
    // 引数は本体より外側に置く。同じ名前の一時変数は影になる（§7.5）。
    scopes.push(new Map());
    const pattern = parsePattern();
    const body = macroBody();
    scopes.pop();

    return { ...pattern, body };
  };

  return { formula, macroBody, macroDefinition };
};

/**
 * 数式（開始記号 `formula`）を解析して AST を返す。
 *
 * @throws {ParseError} 構文の段階で分かる構文エラー
 * @throws {LexicalError} 字句の段階で分かる構文エラー
 */
export function parseFormula(source: string): Expression {
  return createParser(source, 'formula').formula();
}

/**
 * マクロの本体（開始記号 `macro body`）を解析する。**名前を付けずにその場で実行する形**で、
 * CLI や MCP の試し実行がここから入る（§7.1、要件 F-6）。
 *
 * @throws {ParseError} 構文の段階で分かる構文エラー
 * @throws {LexicalError} 字句の段階で分かる構文エラー
 */
export function parseMacroBody(source: string): Body {
  return createParser(source, 'macro').macroBody();
}

/**
 * マクロの定義（開始記号 `macro definition`）を解析する。**ブックに保存する形**で、
 * マクロエディタがここから入る（§7.1、要件 F-3-1）。
 *
 * @throws {ParseError} 構文の段階で分かる構文エラー
 * @throws {LexicalError} 字句の段階で分かる構文エラー
 */
export function parseMacroDefinition(source: string): MacroDefinition {
  return createParser(source, 'macro').macroDefinition();
}
