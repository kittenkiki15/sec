/**
 * 10×10 のグリッド（M3.5、要件 F-7-1）。**再計算が画面に出ることを確かめるための縦切り。**
 *
 * **`LiveSheet` の `put` が返す番地だけを描き直す**（要件 F-4-2）。100 個を毎回
 * 読み直しても 10×10 なら足りるが、**それでは増分再計算が働いているかが画面から分からない。**
 * M3.5 の目的は UX の前提の検証なので、**再計算の粒度をそのまま描き直しの粒度にする。**
 */

import { type CellAddress, columnAt, LiveSheet, printAddress } from '@sec/core/model';
import { type ReactElement, useState } from 'react';
import { type CellDisplay, displayValue } from './display.ts';

/** デモの大きさ（要件定義書 §8 の M3.5）。**仮想スクロール（F-7-7）は M6 以降。** */
export const COLUMN_COUNT = 10;
export const ROW_COUNT = 10;

const COLUMNS: readonly string[] = Array.from({ length: COLUMN_COUNT }, (_, index) =>
  columnAt(BigInt(index + 1)),
);
const ROWS: readonly bigint[] = Array.from({ length: ROW_COUNT }, (_, index) => BigInt(index + 1));

/** 空の升目。**セルが空であることと、まだ一度も触っていないことを区別しない**（ADR-0010）。 */
const BLANK: CellDisplay = { text: '', error: null };

interface Editing {
  readonly address: CellAddress;
  readonly draft: string;
}

export function Grid(): ReactElement {
  const [sheet] = useState(() => new LiveSheet());
  // **描き直す字面を状態として持つ。** `sheet` は変わっても React に伝わらないので、
  // 再計算した番地をここへ写すことが、書き込みと描き直しを対にする手段になる。
  const [displays, setDisplays] = useState<ReadonlyMap<string, CellDisplay>>(() => new Map());
  const [editing, setEditing] = useState<Editing | null>(null);

  /** 編集中の内容を確定し、**計算し直した升目だけ**を描き直す。 */
  function commit(current: Editing): void {
    const recalculated = sheet.put(current.address, current.draft);
    setDisplays((previous) => {
      const next = new Map(previous);
      for (const address of recalculated) {
        next.set(printAddress(address), displayValue(sheet.values(address)));
      }
      return next;
    });
  }

  /**
   * 升目の編集を始める。**別の升目を編集中なら、そちらを先に確定する**——
   * 取りこぼすと、入力したはずの内容が黙って消える。
   */
  function startEditing(address: CellAddress): void {
    if (editing !== null) commit(editing);
    setEditing({ address, draft: sheet.contentAt(address) });
  }

  function handleInputKey(event: React.KeyboardEvent<HTMLInputElement>, current: Editing): void {
    if (event.key === 'Enter') {
      commit(current);
      setEditing(null);
    } else if (event.key === 'Escape') {
      setEditing(null);
    }
  }

  return (
    // 表計算のグリッドは `grid`（表そのものではなく、升目を辿る対象）。
    // 升目に焦点を当てられることが、この role の前提でもある。
    <table
      className="grid"
      // WAI-ARIA は `table` に `grid` を与える形を明示的に認めており（APG のデータグリッドが
      // この形）、規則の側が取りこぼしている。`div` に置き換えると行と列の対応を自前で持つことになる。
      // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: WAI-ARIA が認めている形
      role="grid"
    >
      <thead>
        <tr>
          {/* 左上の角は飾りでしかない。読み上げから外さないと列見出しが 11 個になる。 */}
          <td aria-hidden="true" />
          {COLUMNS.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {ROWS.map((row) => (
          <tr key={row.toString()}>
            <th scope="row">{row.toString()}</th>
            {COLUMNS.map((column) => {
              const address: CellAddress = { column, row };
              const spelling = printAddress(address);
              const display = displays.get(spelling) ?? BLANK;
              const isEditing = editing !== null && printAddress(editing.address) === spelling;

              return (
                <td
                  key={column}
                  // 上の `role="grid"` と対。`grid` の中の `td` は `gridcell` であり、焦点を持てる。
                  // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: 上と同じ理由
                  role="gridcell"
                  tabIndex={0}
                  {...(display.error === null ? {} : { 'data-error': display.error })}
                  onClick={() => {
                    if (!isEditing) startEditing(address);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !isEditing) startEditing(address);
                  }}
                >
                  {isEditing && editing !== null ? (
                    <input
                      ref={(node) => {
                        node?.focus();
                      }}
                      value={editing.draft}
                      onChange={(event) =>
                        setEditing({ address: editing.address, draft: event.target.value })
                      }
                      onKeyDown={(event) => handleInputKey(event, editing)}
                    />
                  ) : (
                    display.text
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
