/**
 * 字句解析器。原文を仕様書 §1.6 のトークンの列に切り出す。
 *
 * **トークンは値へ変換しない。** `007` も `1e3` も原文のまま持たせ、`7` や `1000` への
 * 変換は構文解析器が担う。小数の変換は倍精度に収まらなければ `#Overflow`（§2.1）であり、
 * エラーの生成は木を組む側に寄せた方が、字句解析器が位置と種別だけを見る形で済む。
 *
 * EBNF に書けない付帯規則が 3 つあり、ここが唯一の置き場所になる。
 *
 * - 負のリテラルと二項の `-` の切り分け（§2.1）
 * - 二項セレクタの最長一致（§1.4）
 * - 範囲の糖衣は空白を挟めない（§4.3）
 */

/** 仕様書 §1.6 のトークンの種別。 */
export type TokenKind =
  | 'integer'
  | 'decimal'
  | 'string'
  | 'symbol'
  | 'reserved'
  | 'identifier'
  | 'keyword'
  | 'binary'
  | 'cell'
  | 'range'
  | 'leftParen'
  | 'rightParen'
  | 'leftBracket'
  | 'rightBracket'
  | 'arrayStart'
  | 'period'
  | 'caret'
  | 'assign'
  | 'colon';

/** 切り出したトークン 1 つ。 */
export interface Token {
  readonly kind: TokenKind;
  /** 原文の該当部分。負の符号や引用符も含む。 */
  readonly text: string;
  /** 1 始まりの行。 */
  readonly line: number;
  /** 1 始まりの列。コードポイントで数える。 */
  readonly column: number;
}

/**
 * 字句の段階で分かる構文エラー（要件 F-8-2 の `#Syntax`）。
 * 位置と説明文を持たせるのは要件 F-8-3 のため。ゴールデンテストの期待値には現れない（§0.3）。
 */
export class LexicalError extends Error {
  readonly line: number;
  readonly column: number;

  constructor(message: string, line: number, column: number) {
    super(message);
    this.name = 'LexicalError';
    this.line = line;
    this.column = column;
  }
}

/** §1.4 の二項セレクタを作る文字。 */
const BINARY_CHARACTERS = new Set('+-*/\\~<>=@%|&?,');

/** §1.3 の予約語。識別子には使えない。 */
const RESERVED_WORDS = new Set(['true', 'false', 'nil']);

/** §1.2 / §4.1 のセル参照の形。この綴りは識別子になれない。 */
const CELL_REFERENCE = /^[A-Z]+[0-9]+$/;

/** §1.2 の識別子の形。 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** §1.4 のキーワードセレクタの形。`at:put:` のように 1 つ以上のキーワードが並ぶ。 */
const KEYWORD_SELECTOR = /^(?:[A-Za-z_][A-Za-z0-9_]*:)+$/;

/** §1.6 の 1 文字で決まる区切り記号。 */
const PUNCTUATION: ReadonlyMap<string, TokenKind> = new Map<string, TokenKind>([
  ['(', 'leftParen'],
  [')', 'rightParen'],
  ['[', 'leftBracket'],
  [']', 'rightBracket'],
  ['.', 'period'],
  ['^', 'caret'],
]);

/**
 * §2.1 の「一次式の終端」。この直後の `-` は負のリテラルではなく二項セレクタになる。
 * 範囲トークンは §2.1 の列挙には無いが、§3.1 の `primary` である以上ここに属する。
 */
const PRIMARY_END: ReadonlySet<TokenKind> = new Set<TokenKind>([
  'integer',
  'decimal',
  'string',
  'symbol',
  'reserved',
  'identifier',
  'cell',
  'range',
  'rightParen',
  'rightBracket',
]);

/** §2.1 の付帯規則が見る「直前のトークン」。先頭には直前が無く、そのときも終端ではない。 */
const endsPrimary = (token: Token | undefined): boolean =>
  token !== undefined && PRIMARY_END.has(token.kind);

/** UTF-16 の上位サロゲート。範囲外の `NaN` は比較が偽になるので、末尾でも安全に呼べる。 */
const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

const isDigit = (char: string): boolean => char >= '0' && char <= '9';

const isLetter = (char: string): boolean =>
  (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z');

const isWordStart = (char: string): boolean => isLetter(char) || char === '_';

const isWordPart = (char: string): boolean => isWordStart(char) || isDigit(char);

/**
 * 原文をトークンの列に切り出す。
 *
 * @throws {LexicalError} 字句の段階で分かる構文エラー
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  let column = 1;
  let previous: Token | undefined;

  /** 範囲外では空文字列を返す。`undefined` を持ち回らずに済む。 */
  const peek = (offset = 0): string => source.charAt(index + offset);

  const advance = (count: number): string => {
    const text = source.slice(index, index + count);
    for (const char of text) {
      if (char === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    index += count;
    return text;
  };

  /**
   * 1 文字（コードポイント 1 つ）進む。`index` は UTF-16 のコードユニットで数えるため、
   * サロゲートペアは 2 つ進める。非 ASCII が現れるのは文字列とコメントの中だけで、
   * **そこを 1 文字ずつ進めないと、同じ行の後続トークンの列がずれる。**
   */
  const advanceChar = (): string => advance(isHighSurrogate(source.charCodeAt(index)) ? 2 : 1);

  /** §1.5 のコメント。空白と同じ扱いなのでトークンにしない。 */
  const skipComment = (): void => {
    const startLine = line;
    const startColumn = column;
    advance(1);

    for (;;) {
      const char = peek();
      if (char === '') {
        throw new LexicalError(
          'コメントが閉じていません。" で始めたコメントは " で閉じます（§1.5）。',
          startLine,
          startColumn,
        );
      }
      if (char !== '"') {
        advanceChar();
        continue;
      }
      advance(1);
      // 中の " は二重にして書く。閉じ側と区別が付くのはここだけ。
      if (peek() !== '"') return;
      advance(1);
    }
  };

  const skipTrivia = (): void => {
    for (;;) {
      const char = peek();
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        advance(1);
        continue;
      }
      if (char === '"') {
        skipComment();
        continue;
      }
      return;
    }
  };

  const readWord = (): string => {
    let text = '';
    while (isWordPart(peek())) text += advance(1);
    return text;
  };

  const readDigits = (): string => {
    let text = '';
    while (isDigit(peek())) text += advance(1);
    return text;
  };

  /** §1.4 の最長一致。3 文字以上は認めないので 2 文字で打ち切る。 */
  const readBinary = (): string => {
    const text = advance(1);
    return BINARY_CHARACTERS.has(peek()) ? text + advance(1) : text;
  };

  /** §2.2 の文字列。閉じるまでの全部を原文のまま持つ。 */
  const readString = (): string => {
    const startLine = line;
    const startColumn = column;
    let text = advance(1);

    for (;;) {
      const char = peek();
      if (char === '') {
        throw new LexicalError(
          "文字列が閉じていません。' で始めた文字列は ' で閉じます（§2.2）。",
          startLine,
          startColumn,
        );
      }
      if (char !== "'") {
        text += advanceChar();
        continue;
      }
      text += advance(1);
      // 中の ' は二重にして書く。
      if (peek() !== "'") return text;
      text += advance(1);
    }
  };

  /** 符号を読んだ後の数値。§2.1 の「仮数が整数で指数が非負なら整数」を種別で表す。 */
  const readNumber = (sign: string): { kind: TokenKind; text: string } => {
    let decimal = false;
    let text = sign + readDigits();

    // 小数点の両側に数字が要る。`5.` は文区切りの `.` と紛れるため小数にしない。
    if (peek() === '.' && isDigit(peek(1))) {
      text += advance(1) + readDigits();
      decimal = true;
    }

    // 指数として読めないなら `e` は次のトークンの始まり（`3e` は 3 と識別子 e）。
    const exponentDigit = peek(1) === '-' ? peek(2) : peek(1);
    if (peek() === 'e' && isDigit(exponentDigit)) {
      text += advance(1);
      if (peek() === '-') {
        text += advance(1);
        decimal = true;
      }
      text += readDigits();
    }

    return { kind: decimal ? 'decimal' : 'integer', text };
  };

  /**
   * §4.3 の範囲の糖衣。区切りの前後に空白もコメントも挟めないので、
   * セル参照を読んだ直後の文字だけを見れば足りる。
   */
  const readRangeTail = (): string | null => {
    const delimiter = peek() === ':' ? ':' : peek() === '.' && peek(1) === '.' ? '..' : null;
    if (delimiter === null) return null;

    let end = index + delimiter.length;
    while (isWordPart(source.charAt(end))) end += 1;

    const right = source.slice(index + delimiter.length, end);
    if (!CELL_REFERENCE.test(right)) return null;
    return advance(delimiter.length + right.length);
  };

  for (;;) {
    skipTrivia();
    if (peek() === '') break;

    const startLine = line;
    const startColumn = column;
    const char = peek();
    let kind: TokenKind;
    let text: string;

    if (isDigit(char) || (char === '-' && isDigit(peek(1)) && !endsPrimary(previous))) {
      // 直前が一次式の終端でなければ、この `-` は負のリテラルの一部（§2.1）。
      ({ kind, text } = readNumber(char === '-' ? advance(1) : ''));
    } else if (char === "'") {
      kind = 'string';
      text = readString();
    } else if (char === '#') {
      text = advance(1);
      if (peek() === '(') {
        kind = 'arrayStart';
        text += advance(1);
      } else if (peek() === "'") {
        kind = 'symbol';
        text += readString();
      } else if (BINARY_CHARACTERS.has(peek())) {
        kind = 'symbol';
        text += readBinary();
      } else {
        kind = 'symbol';
        text += readWord();
        // `#at:put:` は 1 つのシンボル。キーワードが続く限り取り込む。
        while (peek() === ':') {
          text += advance(1);
          const next = readWord();
          if (next === '') break;
          text += next;
        }
        const spelling = text.slice(1);
        // `#` の後ろは綴りとして読むので、セル参照の形（`#A1`）も書ける。
        if (!IDENTIFIER.test(spelling) && !KEYWORD_SELECTOR.test(spelling)) {
          throw new LexicalError(
            `"${text}" はシンボルの形ではありません。# の後ろには識別子・キーワードセレクタ・` +
              `二項セレクタ・文字列のいずれかを書きます（§2.3）。`,
            startLine,
            startColumn,
          );
        }
      }
    } else if (isWordStart(char)) {
      text = readWord();
      if (CELL_REFERENCE.test(text)) {
        const tail = readRangeTail();
        kind = tail === null ? 'cell' : 'range';
        if (tail !== null) text += tail;
      } else if (RESERVED_WORDS.has(text)) {
        kind = 'reserved';
      } else if (peek() === ':' && peek(1) !== '=') {
        // 直後が `=` なら代入。`a:=1` をキーワード `a:` と `=` に切らない（§7.3）。
        kind = 'keyword';
        text += advance(1);
      } else {
        kind = 'identifier';
      }
    } else if (char === ':') {
      kind = peek(1) === '=' ? 'assign' : 'colon';
      text = advance(kind === 'assign' ? 2 : 1);
    } else if (BINARY_CHARACTERS.has(char)) {
      kind = 'binary';
      text = readBinary();
    } else {
      const punctuation = PUNCTUATION.get(char);
      if (punctuation === undefined) {
        // サロゲートペアを半分だけ見せないよう、1 文字ぶんを取り出して知らせる。
        throw new LexicalError(
          `"${advanceChar()}" はこの言語で使えない文字です（§1.6）。`,
          startLine,
          startColumn,
        );
      }
      kind = punctuation;
      text = advance(1);
    }

    previous = { kind, text, line: startLine, column: startColumn };
    tokens.push(previous);
  }

  return tokens;
}
