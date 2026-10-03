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

  return { parseSnippets: parseSnippets };
});
