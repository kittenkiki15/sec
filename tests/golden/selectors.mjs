/**
 * 仕様書のセレクタ表と、フィクスチャが送っているセレクタを取り出す。
 *
 * `consistency.test.mjs` の網羅の検査が使う。**検査の本体をテストの中に書かないのは、
 * 抽出が壊れたときに検査が黙って素通りするため**である。表の読み違えや木の辿り漏れは、
 * 「網羅の穴が無い」と区別が付かない形で現れる。関数に分けて単体テストを当てる
 * （`selectors.test.mjs`）。
 */

/** 表のヘッダに使う綴り。前方一致にしない理由は `parseSelectorTables` に書いた。 */
const SELECTOR_HEADER = 'セレクタ';

/**
 * Markdown の表の行をセルに切る。
 *
 * **`\|` はセル区切りではない。** Boolean の `|` セレクタが表の中では `` `\|` `` と
 * 書かれているため、素朴に `split('|')` すると綴りが壊れる。
 *
 * @param {string} line 1 行
 * @returns {string[] | null} セルの並び。表の行でなければ `null`
 */
function splitRow(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) return null;

  const cells = [];
  let cell = '';
  for (let i = 1; i < trimmed.length; i += 1) {
    if (trimmed[i] === '\\' && trimmed[i + 1] === '|') {
      cell += '|';
      i += 1;
      continue;
    }
    if (trimmed[i] === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += trimmed[i];
  }
  // 行末の `|` の後ろに残るのは空白だけ。中身があればセルとして拾う。
  if (cell.trim() !== '') cells.push(cell.trim());
  return cells;
}

/**
 * 仕様書からセレクタ表を拾い、セレクタと、その表が属する見出しの対応を返す。
 *
 * **第 1 セルがちょうど `セレクタ` の表だけを見る。** 前方一致にすると、
 * §7.7 の `| セレクタ（do: を含む） |` や付録 A の `| セレクタの文脈依存 |` が混ざる。
 * どちらも綴りの一覧ではなく、拾うとフィクスチャに無い「セレクタ」が並ぶ。
 *
 * @param {string} markdown 言語仕様書の全文
 * @returns {Map<string, string>} セレクタ → 見出し
 */
export function parseSelectorTables(markdown) {
  const declared = new Map();
  let heading = '';
  let inTable = false;

  for (const line of markdown.split('\n')) {
    if (line.startsWith('#')) {
      heading = line.replace(/^#+\s*/, '').trim();
      inTable = false;
      continue;
    }

    const cells = splitRow(line);
    if (cells === null) {
      inTable = false;
      continue;
    }
    if (cells[0] === SELECTOR_HEADER) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;

    const first = cells[0] ?? '';
    if (first.startsWith('---')) continue;
    for (const quoted of first.match(/`[^`]+`/g) ?? []) {
      const selector = quoted.slice(1, -1);
      if (!declared.has(selector)) declared.set(selector, heading);
    }
  }

  return declared;
}

/**
 * AST を歩いて、送信されているセレクタを集める。
 *
 * **ノードの種類ごとに場合分けせず、木をそのまま辿る。** AST は読み取り専用の
 * 素のオブジェクトと配列でできているため、辿り方を種類ごとに書くと、
 * ノードが増えたときに**足し忘れても検査は緑のまま**になる。
 *
 * マクロ定義の名前（`MacroDefinition.selector`）は送信ではないので拾わない。
 * 呼び出し側が本体だけを渡す。
 *
 * @param {unknown} node 式・文・本体のいずれか
 * @returns {Set<string>} 送信されているセレクタ
 */
export function sentSelectors(node) {
  const found = new Set();

  const walk = (current) => {
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) {
      for (const child of current) walk(child);
      return;
    }
    if (current.kind === 'send' && typeof current.selector === 'string') {
      found.add(current.selector);
    }
    for (const value of Object.values(current)) walk(value);
  };

  walk(node);
  return found;
}
