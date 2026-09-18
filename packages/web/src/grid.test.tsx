// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Grid } from './grid.tsx';

afterEach(cleanup);

/**
 * 番地の升目を、表の構造から引く。**テストのための属性を実装に足さない**ため、
 * 行と列の位置で辿る（「1 行目の A 列」は振る舞いそのものである）。
 */
function cellAt(address: string): HTMLElement {
  const matched = /^([A-Z]+)([0-9]+)$/.exec(address);
  if (matched === null) throw new Error(`番地の形ではない: ${address}`);
  const [, column, row] = matched as unknown as [string, string, string];

  const columns = screen.getAllByRole('columnheader').map((header) => header.textContent);
  const columnIndex = columns.indexOf(column);
  if (columnIndex < 0) throw new Error(`列が無い: ${column}`);

  const rows = screen.getAllByRole('row');
  const found = rows.find(
    (element) => within(element).queryAllByRole('rowheader')[0]?.textContent === row,
  );
  if (found === undefined) throw new Error(`行が無い: ${row}`);

  const cells = within(found).getAllByRole('gridcell');
  const cell = cells[columnIndex];
  if (cell === undefined) throw new Error(`升目が無い: ${address}`);
  return cell;
}

/**
 * 升目をクリックし、**内容を入れ替えて** Enter で確定する。
 *
 * **消してから打つ。** 編集は原文を持った状態で始まる（Excel と同じく直せる形）ので、
 * 消さずに打つと元の内容の後ろに続いてしまう。
 */
async function type(address: string, content: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(cellAt(address));
  await user.clear(screen.getByRole('textbox'));
  await user.keyboard(`${content}{Enter}`);
}

describe('Grid', () => {
  it('10×10 の升目と、A〜J の列見出し・1〜10 の行見出しが出る', () => {
    render(<Grid />);

    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual([
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'J',
    ]);
    expect(screen.getAllByRole('rowheader').map((header) => header.textContent)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      '10',
    ]);
    expect(screen.getAllByRole('gridcell')).toHaveLength(100);
  });

  it('初めはすべての升目が空欄（空セルの値は nil、ADR-0010）', () => {
    render(<Grid />);

    expect(screen.getAllByRole('gridcell').every((cell) => cell.textContent === '')).toBe(true);
  });

  it('升目に値を入れて確定すると、その値が出る', async () => {
    render(<Grid />);

    await type('A1', '42');

    expect(cellAt('A1').textContent).toBe('42');
  });

  it('数式は評価された値が出る（原文ではない）', async () => {
    render(<Grid />);

    await type('A1', '2');
    await type('B1', '=A1 * 3');

    expect(cellAt('B1').textContent).toBe('6');
  });

  it('参照先を変えると下流が計算し直される（要件 F-4-2）', async () => {
    render(<Grid />);

    await type('A1', '2');
    await type('B1', '=A1 * 3');
    await type('A1', '10');

    expect(cellAt('B1').textContent).toBe('30');
  });

  it('編集中は値ではなく原文が出る（数式を直せる）', async () => {
    const user = userEvent.setup();
    render(<Grid />);

    await type('A1', '=1 + 1');
    await user.click(cellAt('A1'));

    expect(screen.getByRole('textbox')).toHaveProperty('value', '=1 + 1');
  });

  it('Escape で編集を取り消す', async () => {
    const user = userEvent.setup();
    render(<Grid />);

    await type('A1', '7');
    await user.click(cellAt('A1'));
    await user.keyboard('99{Escape}');

    expect(cellAt('A1').textContent).toBe('7');
  });

  it('解決できない番地を参照すると #Ref になり、印が付く（要件 F-8-2）', async () => {
    render(<Grid />);

    // 行は 1 始まりなので `A0` は解決できない（仕様書 §4.2）。
    await type('A1', '=A0 + 1');

    expect(cellAt('A1').textContent).toBe('#Ref');
    expect(cellAt('A1').dataset.error).toBe('Ref');
  });

  it('10×10 は窓であって、シートの広さではない（窓の外も空のセルとして読める）', async () => {
    render(<Grid />);

    // 窓の外を指しても `#Ref` にはならない。空のセルの値は `nil` で（ADR-0010）、
    // `nil + 1` は `#DoesNotUnderstand` になる。
    await type('A1', '=ZZ999 + 1');

    expect(cellAt('A1').textContent).toBe('#DoesNotUnderstand');
    expect(cellAt('A1').dataset.error).toBe('DoesNotUnderstand');
  });

  it('循環参照は #Circular になり、関与セルすべてに印が付く（要件 F-4-3）', async () => {
    render(<Grid />);

    await type('A1', '=B1');
    await type('B1', '=A1');

    expect(cellAt('A1').textContent).toBe('#Circular');
    expect(cellAt('B1').textContent).toBe('#Circular');
    expect(cellAt('B1').dataset.error).toBe('Circular');
  });

  it('エラーでない升目には印が付かない', async () => {
    render(<Grid />);

    await type('A1', '1');

    expect(cellAt('A1').dataset.error).toBeUndefined();
  });

  it('別の升目をクリックすると、編集中の内容が黙って消えずに確定する', async () => {
    const user = userEvent.setup();
    render(<Grid />);

    await user.click(cellAt('A1'));
    await user.keyboard('7');
    await user.click(cellAt('B1'));

    expect(cellAt('A1').textContent).toBe('7');
  });

  it('升目に焦点を当てて Enter を押すと編集を始められる（キーボードだけで届く）', async () => {
    const user = userEvent.setup();
    render(<Grid />);

    cellAt('A1').focus();
    await user.keyboard('{Enter}8{Enter}');

    expect(cellAt('A1').textContent).toBe('8');
  });

  it('内容を空にするとセルが空になる（ADR-0010）', async () => {
    const user = userEvent.setup();
    render(<Grid />);

    await type('A1', '5');
    await user.click(cellAt('A1'));
    await user.keyboard('{Control>}a{/Control}{Delete}{Enter}');

    expect(cellAt('A1').textContent).toBe('');
  });
});
