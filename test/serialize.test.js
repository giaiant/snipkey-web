'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSnippets, serializeSnippets, extractPreamble, validateSnippets, hasFenceLine } = require('../parser.js');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

function roundTrip(text) {
  const items = parseSnippets(text);
  const out = serializeSnippets(items, extractPreamble(text));
  return { items: items, out: out, again: parseSnippets(out) };
}

for (const [name, rel] of [['spec/fixtures/sample.md', ['spec', 'fixtures', 'sample.md']], ['data/snippets.md', ['data', 'snippets.md']]]) {
  test(name + '：parse → serialize → parse の結果が一致する', () => {
    const text = read(...rel);
    const r = roundTrip(text);
    assert.ok(r.items.length > 0);
    assert.deepEqual(r.again, r.items);
    // 説明文はそのまま残る
    assert.ok(r.out.startsWith(extractPreamble(text).replace(/\n+$/, '') + '\n\n## '));
    // 2回目以降は文字列としても変わらない
    assert.equal(serializeSnippets(r.again, extractPreamble(r.out)), r.out);
  });

  test(name + '：CRLF と BOM 付きでも同じ件になり、書き出しは LF になる', () => {
    const text = '﻿' + read(...rel).replace(/\r?\n/g, '\r\n');
    const r = roundTrip(text);
    assert.deepEqual(r.again, r.items);
    assert.ok(!r.out.includes('\r'));
    assert.ok(!r.out.startsWith('﻿'));
  });
}

test('既定値と同じキーは省略し、type は常に書く', () => {
  const md = serializeSnippets([
    { title: 'a', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: 'x' },
    { title: 'b', type: 'run', tags: ['t1', 't2'], shell: 'cmd', confirm: false, window: 'hidden', body: 'y' },
  ], '# head\n');
  assert.equal(md,
    '# head\n\n' +
    '## a\ntype: paste\n\n~~~\nx\n~~~\n\n' +
    '## b\ntype: run\ntags: t1, t2\nshell: cmd\nconfirm: false\nwindow: hidden\n\n~~~\ny\n~~~\n');
});

test('説明文が無くても書ける', () => {
  const items = [{ title: 'a', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: '' }];
  const md = serializeSnippets(items, '');
  assert.equal(md, '## a\ntype: paste\n\n~~~\n~~~\n');
  assert.deepEqual(parseSnippets(md), items);
});

test('本文の端の空行・``` の囲み・## 行・CRLF を保つ', () => {
  const items = [
    { title: 'a', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: '\n```js\nx\n```\n## not title\n' },
    { title: 'b', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: '\n' },
  ];
  assert.deepEqual(parseSnippets(serializeSnippets(items, '')), items);
  const crlf = [Object.assign({}, items[0], { body: 'l1\r\nl2' })];
  assert.equal(parseSnippets(serializeSnippets(crlf, ''))[0].body, 'l1\nl2');
});

test('タイトルの前後の空白は除く（読む時と同じ）', () => {
  const items = [{ title: '  a  ', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: 'x' }];
  assert.equal(parseSnippets(serializeSnippets(items, ''))[0].title, 'a');
});

test('本文に ~~~ だけの行があれば保存できない', () => {
  assert.equal(hasFenceLine('a\n~~~\nb'), true);
  assert.equal(hasFenceLine('a\n  ~~~  \nb'), true);
  assert.equal(hasFenceLine('a ~~~ b\n~~~~'), false);
  const items = [{ title: 'a', type: 'paste', tags: [], body: 'x\n~~~\ny' }];
  assert.throws(() => serializeSnippets(items, ''), /~~~/);
  assert.deepEqual(validateSnippets(items), [{ index: 0, field: 'body', message: '本文に「~~~」だけの行は書けません' }]);
});

test('タイトルが空・重複の件は保存できない', () => {
  const base = { type: 'paste', tags: [], body: 'x' };
  const errs = validateSnippets([
    Object.assign({ title: 'a' }, base),
    Object.assign({ title: ' ' }, base),
    Object.assign({ title: 'a ' }, base),
    Object.assign({ title: 'b' }, base),
  ]);
  assert.deepEqual(errs.map((e) => [e.index, e.field]), [[1, 'title'], [2, 'title']]);
  assert.match(errs[1].message, /重複/);
  assert.throws(() => serializeSnippets([Object.assign({ title: '' }, base)], ''), /タイトルが空/);
});

test('extractPreamble は最初の ## より前だけを返す', () => {
  assert.equal(extractPreamble('# t\r\n\r\nmemo\r\n## a\r\n~~~\r\n~~~\r\n'), '# t\n\nmemo');
  assert.equal(extractPreamble('## a\n~~~\n~~~\n'), '');
});
