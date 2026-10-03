// snipkey: data/snippets.md のパーサ（形式は SPEC.md「データ形式」）。
// ブラウザでは window.SnipkeyParser、Node では require('./parser.js') で使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipkeyParser = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FENCE = '~~~';
  const DEFAULTS = { type: 'paste', shell: 'powershell', confirm: true, window: 'keep' };
  const ALLOWED = {
    type: ['paste', 'run'],
    shell: ['powershell', 'pwsh', 'cmd'],
    window: ['keep', 'hidden'],
  };

  function newSnippet(title) {
    return {
      title: title,
      type: DEFAULTS.type,
      tags: [],
      shell: DEFAULTS.shell,
      confirm: DEFAULTS.confirm,
      window: DEFAULTS.window,
      body: null,
    };
  }

  function applyMeta(snip, line) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) return;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'tags') {
      snip.tags = value.split(',').map((t) => t.trim()).filter(Boolean);
    } else if (key === 'confirm') {
      snip.confirm = value.toLowerCase() !== 'false';
    } else if (ALLOWED[key]) {
      const v = value.toLowerCase();
      snip[key] = ALLOWED[key].includes(v) ? v : DEFAULTS[key];
    }
    // 知らないキーは無視する
  }

  function parseSnippets(text) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
    const out = [];
    let cur = null; // 読んでいる件
    let state = 'preamble'; // preamble | meta | body | after
    let bodyLines = [];

    for (const line of lines) {
      if (state === 'body') {
        if (line.trim() === FENCE) {
          cur.body = bodyLines.join('\n');
          out.push(cur);
          state = 'after';
        } else {
          bodyLines.push(line);
        }
        continue;
      }
      if (line.startsWith('## ')) {
        cur = newSnippet(line.slice(3).trim());
        state = 'meta';
        continue;
      }
      if (state !== 'meta') continue; // 説明文・本文の後の行は無視
      if (line.trim() === FENCE) {
        state = 'body';
        bodyLines = [];
      } else if (line.trim() !== '' && !line.startsWith('# ')) {
        applyMeta(cur, line);
      }
    }
    // 閉じていない囲み・本文の無い件は読み飛ばす
    return out;
  }

  // ---- 書き出し（編集画面の保存用） ----

  function toLf(s) {
    return String(s).replace(/\r\n?/g, '\n');
  }

  // 最初の `## ` 行より前の説明文。そのまま残すために使う（BOM は除き、改行は LF にそろえる）
  function extractPreamble(text) {
    const lines = toLf(String(text).replace(/^﻿/, '')).split('\n');
    const i = lines.findIndex((l) => l.startsWith('## '));
    return (i < 0 ? lines : lines.slice(0, i)).join('\n');
  }

  // 本文の中に `~~~` だけの行があると囲みが閉じてしまうので保存できない
  function hasFenceLine(body) {
    return toLf(body).split('\n').some((l) => l.trim() === FENCE);
  }

  function normalizeTitle(title) {
    return String(title).trim();
  }

  // 保存できない件を調べる。返り値は [{ index, field: 'title'|'body', message }]
  function validateSnippets(items) {
    const errors = [];
    const seen = new Map();
    items.forEach((it, index) => {
      const title = normalizeTitle(it.title);
      if (title === '') {
        errors.push({ index: index, field: 'title', message: 'タイトルが空です' });
      } else if (/[\r\n]/.test(title)) {
        errors.push({ index: index, field: 'title', message: 'タイトルに改行は使えません' });
      } else if (seen.has(title)) {
        errors.push({ index: index, field: 'title', message: '「' + title + '」はほかの件と重複しています' });
      } else {
        seen.set(title, index);
      }
      if (hasFenceLine(it.body)) {
        errors.push({ index: index, field: 'body', message: '本文に「~~~」だけの行は書けません' });
      }
    });
    return errors;
  }

  function serializeOne(it) {
    const lines = ['## ' + normalizeTitle(it.title)];
    lines.push('type: ' + (it.type === 'run' ? 'run' : 'paste')); // type は常に書く
    const tags = (it.tags || []).map((t) => String(t).trim()).filter(Boolean);
    if (tags.length) lines.push('tags: ' + tags.join(', '));
    // 既定値と同じキーは省略する（paste の件でも、既定と違う値は失わないように書く）
    if (it.shell && it.shell !== DEFAULTS.shell) lines.push('shell: ' + it.shell);
    if (it.confirm === false) lines.push('confirm: false');
    if (it.window && it.window !== DEFAULTS.window) lines.push('window: ' + it.window);
    lines.push('', FENCE);
    const body = toLf(it.body == null ? '' : it.body);
    if (body !== '') lines.push(body);
    // 本文が空の時も、本文が改行で終わる時も、閉じの前の改行1つは囲みの一部なので内容は保たれる
    lines.push(FENCE);
    return lines.join('\n');
  }

  // 件の配列から SPEC.md 形式の Markdown を作る。保存できない件があれば例外を投げる。
  function serializeSnippets(items, preamble) {
    const errors = validateSnippets(items);
    if (errors.length) {
      const e = new Error(errors.map((x) => (x.index + 1) + '件目: ' + x.message).join('\n'));
      e.errors = errors;
      throw e;
    }
    const parts = [];
    const head = toLf(preamble || '').replace(/^﻿/, '').replace(/\n+$/, '');
    if (head !== '') parts.push(head);
    for (const it of items) parts.push(serializeOne(it));
    return parts.join('\n\n') + '\n';
  }

  return {
    parseSnippets: parseSnippets,
    extractPreamble: extractPreamble,
    hasFenceLine: hasFenceLine,
    validateSnippets: validateSnippets,
    serializeSnippets: serializeSnippets,
  };
});
