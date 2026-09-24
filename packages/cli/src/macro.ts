/**
 * `sec run` の 1 回のマクロ実行。**Worker の中で走る**（`macro-worker.ts`）が、
 * それ自体は process にも Worker にも触れない純粋な関数なので、起動せずにテストできる。
 *
 * 受け渡すのは構造化複製できるものだけにしてある。**値は表記にしてから返す**——
 * ブロックのような値は Worker の境界を越えられない。
 */

import {
  type Diagnostic,
  evaluateMacro,
  evaluateMacroDefinition,
  printValue,
  readMacroMessage,
} from '@sec/core/eval';
import { type CellAddress, LiveSheet, printAddress } from '@sec/core/model';
import { compareAddresses, type SheetCells } from './sheet-file.ts';

/** マクロを走らせる依頼。 */
export interface MacroRequest {
  /** マクロの原文。宣言部を持つ定義か、宣言部の無い本体（§7.1）。 */
  readonly source: string;
  /** 開始前のシート。 */
  readonly cells: SheetCells;
  /** 宣言部を持つ定義を起動する送信の原文（`from: 1 to: 3`）。本体だけなら `null`。 */
  readonly send: string | null;
}

/** マクロを走らせた結果。 */
export type MacroOutcome =
  | {
      readonly kind: 'ran';
      /** マクロの値の表記（§0.3）。 */
      readonly value: string;
      /** 値がエラーだったか。**そのときは書き込みが巻き戻っている**（F-3-4）。 */
      readonly failed: boolean;
      /** 構文エラーの位置と説明文（要件 F-8-3）。 */
      readonly diagnostic?: Diagnostic;
      /** 確定した書き込み。書き込んだセルと、そのセルの終了時の内容。**空にしたセルは空文字列。** */
      readonly written: SheetCells;
      /** 終了時の空でない全セル。 */
      readonly cells: SheetCells;
    }
  | {
      /** 送信を 1 つの送信として読めなかった。**仕様上のエラーではなく使い方の誤り**（§7.1）。 */
      readonly kind: 'invalidSend';
    };

/** マクロを走らせる。 */
export function executeMacro({ source, cells, send }: MacroRequest): MacroOutcome {
  const live = new LiveSheet(cells);
  const touched = new Map<string, CellAddress>(
    cells.map(([address]) => [printAddress(address), address]),
  );
  const written = new Map<string, CellAddress>();

  // 書き込んだセルを知るために、トランザクションの `put` だけを覗く。
  // **読みは素通しする**——同じマクロの中で書き込みが下流に届くのはトランザクションの側の仕事。
  const sheet = {
    begin: () => {
      const transaction = live.begin();
      return {
        get values() {
          return transaction.values;
        },
        put: (address: CellAddress, content: string) => {
          transaction.put(address, content);
          written.set(printAddress(address), address);
          touched.set(printAddress(address), address);
        },
        commit: () => transaction.commit(),
        rollback: () => transaction.rollback(),
      };
    },
  };

  let evaluation: ReturnType<typeof evaluateMacro>;
  if (send === null) {
    evaluation = evaluateMacro(source, sheet);
  } else {
    const message = readMacroMessage(send, live.values);
    if (message === null) return { kind: 'invalidSend' };
    evaluation = evaluateMacroDefinition(source, message, sheet);
  }

  const { value, diagnostic } = evaluation;
  const failed = value.kind === 'error';
  const withContent = (addresses: Iterable<CellAddress>) =>
    [...addresses]
      .sort(compareAddresses)
      .map((address) => [address, live.contentAt(address)] as const);

  return {
    kind: 'ran',
    value: printValue(value),
    failed,
    ...(diagnostic === undefined ? {} : { diagnostic }),
    // 巻き戻したマクロの書き込みは何も残っていない。
    written: failed ? [] : withContent(written.values()),
    cells: withContent(touched.values()).filter(([, content]) => content !== ''),
  };
}
