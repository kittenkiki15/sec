import { parseAddress } from '@sec/core/model';
import { describe, expect, it } from 'vitest';
import { printSheetFile, readSheetFile } from './sheet-file.ts';

/** 綴りから番地を作る。テストの綴りは正しいので、読めなければテストの誤り。 */
const at = (spelling: string) => {
  const address = parseAddress(spelling);
  if (address === null) throw new Error(`${spelling} は番地ではありません。`);
  return address;
};

describe('シートの JSON を読む', () => {
  it('番地から内容の原文への対応を読む', () => {
    expect(readSheetFile('{"A1": "3", "B1": "=A1 * 2"}')).toEqual({
      cells: [
        [at('A1'), '3'],
        [at('B1'), '=A1 * 2'],
      ],
    });
  });

  it('空のオブジェクトは空のシート', () => {
    expect(readSheetFile('{}')).toEqual({ cells: [] });
  });

  // 空の内容はセルを空にすること（ADR-0010）。持っても意味が無い。
  it('内容が空文字列のセルは読み飛ばす', () => {
    expect(readSheetFile('{"A1": "", "A2": "1"}')).toEqual({ cells: [[at('A2'), '1']] });
  });

  // 番地は正規化する（ADR-0020）。
  it('番地を正規化する', () => {
    expect(readSheetFile('{"a007": "1"}')).toEqual({ cells: [[at('A7'), '1']] });
  });

  // 正規化すると同じセルになる 2 つの綴りは、どちらを採っても黙って片方が消える。
  it('正規化して同じセルになる綴りが 2 つあれば拒む', () => {
    const result = readSheetFile('{"A7": "1", "A007": "2"}');
    expect(result).toHaveProperty('error');
    expect(JSON.stringify(result)).toContain('A007');
  });

  it('JSON として読めなければ拒む', () => {
    expect(readSheetFile('{"A1": ')).toHaveProperty('error');
  });

  it('最上位がオブジェクトでなければ拒む', () => {
    expect(readSheetFile('["A1", "3"]')).toHaveProperty('error');
    expect(readSheetFile('null')).toHaveProperty('error');
    expect(readSheetFile('"A1"')).toHaveProperty('error');
  });

  it('番地の形でないキーはその綴りを言って拒む', () => {
    const result = readSheetFile('{"total": "3"}');
    expect(JSON.stringify(result)).toContain('total');
  });

  // A0 は番地の形だが存在しない（§4.2）。置けるセルが無い。
  it('存在しない番地は拒む', () => {
    expect(readSheetFile('{"A0": "3"}')).toHaveProperty('error');
  });

  // 数を受けると、3 と "3" と "'3'" のどれとして置いたのかが曖昧になる（ADR-0021）。
  it('内容が文字列でなければ拒む', () => {
    expect(readSheetFile('{"A1": 3}')).toHaveProperty('error');
    expect(readSheetFile('{"A1": null}')).toHaveProperty('error');
  });
});

describe('シートの JSON を書く', () => {
  it('番地から内容の原文への対応を書く', () => {
    expect(JSON.parse(printSheetFile([[at('A1'), '3']]))).toEqual({ A1: '3' });
  });

  // 読めば同じシートに戻る。
  it('書いたものを読むと同じセルになる', () => {
    const cells = [
      [at('A1'), "'It''s'"],
      [at('B2'), '=A1 , "x"'],
    ] as const;
    expect(readSheetFile(printSheetFile(cells))).toEqual({ cells });
  });

  // 読む人のために行ごとにまとめる。置いた順では書き込みの順が見た目に出てしまう。
  it('行を先に、列を後に並べる', () => {
    const text = printSheetFile([
      [at('B2'), '4'],
      [at('AA1'), '3'],
      [at('B1'), '2'],
      [at('A2'), '1'],
    ]);
    expect(Object.keys(JSON.parse(text))).toEqual(['B1', 'AA1', 'A2', 'B2']);
  });

  it('空のシートは空のオブジェクト', () => {
    expect(JSON.parse(printSheetFile([]))).toEqual({});
  });

  // テキストファイルの慣習。無いと cat したときにプロンプトが行末に続く。
  it('末尾は改行', () => {
    expect(printSheetFile([])).toMatch(/\n$/);
  });
});
