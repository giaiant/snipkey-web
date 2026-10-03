'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSnippets } = require('../parser.js');

const root = path.join(__dirname, '..', '..');
const fixture = (name) => fs.readFileSync(path.join(root, 'spec', 'fixtures', name), 'utf8');

test('sample.md を読んだ結果が sample.expected.json と一致する', () => {
  const expected = JSON.parse(fixture('sample.expected.json'));
  assert.deepEqual(parseSnippets(fixture('sample.md')), expected);
});

test('CRLF と BOM 付きでも同じ結果になる', () => {
  const expected = JSON.parse(fixture('sample.expected.json'));
  const crlf = '﻿' + fixture('sample.md').replace(/\r?\n/g, '\r\n');
  assert.deepEqual(parseSnippets(crlf), expected);
});

test('data/snippets.md を読める', () => {
  const text = fs.readFileSync(path.join(root, 'data', 'snippets.md'), 'utf8');
  const items = parseSnippets(text);
  assert.ok(items.length > 0);
  for (const it of items) {
    assert.ok(it.title);
    assert.ok(it.type === 'paste' || it.type === 'run');
  }
});

test('本文の中の ## 行や # 行は本文として残る', () => {
  const md = '## a\n~~~\n## not title\n# not comment\n~~~\n';
  assert.deepEqual(parseSnippets(md).map((s) => s.body), ['## not title\n# not comment']);
});

test('閉じていない本文の囲みは読み飛ばす', () => {
  const md = '## ok\n~~~\nx\n~~~\n## broken\n~~~\ny\n';
  assert.deepEqual(parseSnippets(md).map((s) => s.title), ['ok']);
});

test('空の本文と、本文前の空行を受け付ける', () => {
  const md = '## empty\n\ntype: run\n\n~~~\n~~~\n';
  const [s] = parseSnippets(md);
  assert.equal(s.body, '');
  assert.equal(s.type, 'run');
});

test('本文の両端の空行は本文に含まれる（両端の改行だけ除く）', () => {
  const md = '## a\n~~~\n\nx\n\n~~~\n';
  assert.equal(parseSnippets(md)[0].body, '\nx\n');
});

test('知らない値は既定値になる', () => {
  const md = '## a\ntype: exec\nshell: bash\nconfirm: maybe\nwindow: big\n~~~\nx\n~~~\n';
  const [s] = parseSnippets(md);
  assert.equal(s.type, 'paste');
  assert.equal(s.shell, 'powershell');
  assert.equal(s.confirm, true);
  assert.equal(s.window, 'keep');
});
