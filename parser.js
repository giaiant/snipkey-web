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

  // ---- カテゴリ（説明文の中の HTML コメントの塊） ----
  // <!-- snipkey:categories
  // プロンプト: Sプロンプト, Lプロンプト
  // -->
  // 1行が1カテゴリ（「名前: タグ, タグ」）。順番が表示の順。説明文は Windows 側では無視されるので影響しない。
  const CAT_BLOCK = /<!--[ \t]*snipkey:categories[ \t]*\n([\s\S]*?)-->/;

  // 名前に使えない書き方（行の形や HTML コメントが壊れる）
  function categoryNameError(name) {
    const n = String(name).trim();
    if (n === '') return 'カテゴリの名前が空です';
    if (/[:：,，\r\n]/.test(n)) return '名前に「:」「,」や改行は使えません';
    if (n.startsWith('#')) return '名前を「#」で始めることはできません';
    if (n.includes('--')) return '名前に「--」は使えません';
    return '';
  }

  // 説明文からカテゴリを読む。塊が無ければ []。不正な行（「:」が無い・名前が空・同じ名前の2回目）は無視する
  function parseCategories(preamble) {
    const m = CAT_BLOCK.exec(toLf(preamble || ''));
    if (!m) return [];
    const out = [];
    for (const raw of m[1].split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      const lm = /^([^:：]+)[:：](.*)$/.exec(line);
      if (!lm) continue;
      const name = lm[1].trim();
      if (categoryNameError(name) || out.some((c) => c.name === name)) continue;
      const tags = [];
      for (const t of lm[2].split(/[,，、]/).map((x) => x.trim()).filter(Boolean)) {
        if (!tags.includes(t)) tags.push(t);
      }
      out.push({ name: name, tags: tags });
    }
    return out;
  }

  function formatCategoryBlock(categories) {
    const lines = categories.map((c) => c.name.trim() + ': ' + c.tags.map((t) => String(t).trim()).filter(Boolean).join(', '));
    return '<!-- snipkey:categories\n' + lines.join('\n') + (lines.length ? '\n' : '') + '-->';
  }

  // 説明文の中の塊だけを書き換える。塊が無ければ末尾に足し、カテゴリが空なら塊を消す。ほかの部分はそのまま残す
  function setCategories(preamble, categories) {
    const text = toLf(preamble || '');
    for (const c of categories) {
      const err = categoryNameError(c.name);
      if (err) throw new Error(err + '（' + c.name + '）');
      for (const t of c.tags) {
        if (/[,，、\r\n]/.test(t) || String(t).includes('-->')) throw new Error('タグ「' + t + '」はカテゴリに書けません');
      }
    }
    const m = CAT_BLOCK.exec(text);
    if (categories.length === 0) {
      if (!m) return text;
      // 塊を消し、前後の空行を1つにまとめる
      const before = text.slice(0, m.index).replace(/\n+$/, '');
      const after = text.slice(m.index + m[0].length).replace(/^\n+/, '');
      const joined = before && after ? before + '\n\n' + after : before || after;
      return joined && /\n$/.test(text) && !/\n$/.test(joined) ? joined + '\n' : joined;
    }
    const block = formatCategoryBlock(categories);
    if (m) return text.slice(0, m.index) + block + text.slice(m.index + m[0].length);
    const head = text.replace(/\n+$/, '');
    return head === '' ? block + '\n' : head + '\n\n' + block + '\n';
  }

  return {
    parseCategories: parseCategories,
    setCategories: setCategories,
    categoryNameError: categoryNameError,
    parseSnippets: parseSnippets,
    extractPreamble: extractPreamble,
    hasFenceLine: hasFenceLine,
    validateSnippets: validateSnippets,
    serializeSnippets: serializeSnippets,
  };
});
