import { parseAddress } from '@sec/core/model';
import { describe, expect, it } from 'vitest';
import { executeMacro, type MacroRequest } from './macro.ts';

const at = (spelling: string) => {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} は番地ではありません。`);
  return address;
};

/** `{ A1: '3' }` の形からシートのセルを作る。 */
const cellsOf = (cells: Record<string, string>) =>
  Object.entries(cells).map(([spelling, content]) => [at(spelling), content] as const);

const request = (
  source: string,
  cells: Record<string, string> = {},
  send: string | null = null,
): MacroRequest => ({ source, cells: cellsOf(cells), send });

describe('マクロを走らせる', () => {
  it('値を §0.3 の表記で返す', () => {
    expect(executeMacro(request('^ 3 + 4'))).toMatchObject({
      kind: 'ran',
      value: '7',
      failed: false,
    });
  });

  it('^ が無ければ nil', () => {
    expect(executeMacro(request('1 + 1'))).toMatchObject({ value: 'nil' });
  });

  it('シートのセルを読む', () => {
    expect(executeMacro(request('^ A1 value * 2', { A1: '21' }))).toMatchObject({ value: '42' });
  });

  it('書き込んだセルを、書き込んだ後の内容で返す', () => {
    const outcome = executeMacro(request("B1 := A1 value * 2. C1 := 'done'", { A1: '3' }));
    expect(outcome).toMatchObject({
      written: cellsOf({ B1: '6', C1: "'done'" }),
    });
  });

  // 同じセルに 2 度書いても 1 つ。最後の内容が残っている。
  it('同じセルへの書き込みは 1 つにまとめる', () => {
    const outcome = executeMacro(request('A1 := 1. A1 := 2'));
    expect(outcome).toMatchObject({ written: cellsOf({ A1: '2' }) });
  });

  // nil はセルを空にする（ADR-0027）。空にしたことも書き込みとして見せる。
  it('空にしたセルは内容が空文字列の書き込みとして返す', () => {
    const outcome = executeMacro(request('A1 := nil', { A1: '3' }));
    expect(outcome).toMatchObject({ written: [[at('A1'), '']], cells: [] });
  });

  it('実行後の空でない全セルを返す。書き込まなかったセルも含む', () => {
    const outcome = executeMacro(request('B1 := 6', { A1: '3', A2: '=A1 + 1' }));
    expect(outcome).toMatchObject({
      cells: cellsOf({ A1: '3', B1: '6', A2: '=A1 + 1' }),
    });
  });

  // 失敗したマクロの書き込みは残らない（F-3-4）。
  it('エラーで終わったら書き込みを返さず、セルも開始前のまま', () => {
    const outcome = executeMacro(request('A1 := 9. B1 := 1 / 0', { A1: '3' }));
    expect(outcome).toMatchObject({
      value: '#DivideByZero',
      failed: true,
      written: [],
      cells: cellsOf({ A1: '3' }),
    });
  });

  it('構文エラーは #Syntax と位置を返す', () => {
    const outcome = executeMacro(request('^ 3 +'));
    expect(outcome).toMatchObject({ value: '#Syntax', failed: true });
    expect(outcome).toHaveProperty('diagnostic.line', 1);
  });

  it('実行時のエラーには診断を付けない', () => {
    expect(executeMacro(request('^ 1 / 0'))).not.toHaveProperty('diagnostic');
  });
});

describe('宣言部を持つ定義を起動する', () => {
  const sum = 'from: a to: b\n  ^ (a to: b) inject: 0 into: [:s :x | s + x]';

  it('送信のセレクタと引数でマクロを起動する', () => {
    expect(executeMacro(request(sum, {}, 'from: 1 to: 3'))).toMatchObject({ value: '6' });
  });

  // ゴールデンテストのハーネスと同じく、引数はマクロが書き込むシートで評価する。
  it('引数はシートのセルを読める', () => {
    expect(executeMacro(request(sum, { A1: '4' }, 'from: 1 to: A1 value'))).toMatchObject({
      value: '10',
    });
  });

  it('パターンと違うセレクタは #DoesNotUnderstand', () => {
    expect(executeMacro(request(sum, {}, 'to: 3'))).toMatchObject({
      value: '#DoesNotUnderstand',
      failed: true,
    });
  });

  it('宣言部の無い本体に送信を添えると #Syntax', () => {
    expect(executeMacro(request('^ 3', {}, 'run'))).toMatchObject({ value: '#Syntax' });
  });

  // 起動の構文は言語に無い（§7.1）ので、読めない送信は仕様上のエラー値ではなく使い方の誤り。
  it('1 つの送信として読めなければ使い方の誤り', () => {
    expect(executeMacro(request(sum, {}, 'from: 1 to:'))).toMatchObject({ kind: 'invalidSend' });
    expect(executeMacro(request(sum, {}, 'from: 1. to: 3'))).toMatchObject({
      kind: 'invalidSend',
    });
  });

  it('送信の後に続きがあれば使い方の誤り', () => {
    // `foo` の結果に `bar` を送る形。起動するメッセージは 1 つでなければならない。
    expect(executeMacro(request(sum, {}, 'foo bar'))).toMatchObject({ kind: 'invalidSend' });
  });
});
