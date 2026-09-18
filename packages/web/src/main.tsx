/**
 * ブラウザへの差し込み口。**振る舞いを持たない**ので、ここだけはテストを持たない
 * （ADR-0026。カバレッジの対象からも外してある）。
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Grid } from './grid.tsx';
import './styles.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root が見つかりません');

createRoot(container).render(
  <StrictMode>
    <main>
      <h1>sec — 動くデモ</h1>
      <p>
        升目をクリックすると編集できます。値（<code>42</code>、<code>'abc'</code>）か、
        <code>=</code> で始まる数式（<code>=A1 + B1</code>、<code>=A1:A5 sum</code>）を入れて Enter
        で確定します。Escape で取り消します。
      </p>
      <Grid />
    </main>
  </StrictMode>,
);
