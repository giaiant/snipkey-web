'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildContentsRequest, filterSnippets, DEFAULT_SETTINGS } = require('../lib.js');

test('既定の設定で Contents API の URL と raw 用ヘッダを組み立てる', () => {
  const req = buildContentsRequest(DEFAULT_SETTINGS, 'TOKEN');
  assert.equal(req.url, 'https://api.github.com/repos/giaiant/snipkey/contents/data/snippets.md?ref=main');
  assert.equal(req.headers.Accept, 'application/vnd.github.raw');
  assert.equal(req.headers.Authorization, 'Bearer TOKEN');
});

test('path の各部分と branch を URL 用に符号化し、先頭の / を除く', () => {
  const req = buildContentsRequest({ path: '/my dir/メモ.md', branch: 'feat/x' }, '');
  assert.equal(
    req.url,
    'https://api.github.com/repos/giaiant/snipkey/contents/my%20dir/%E3%83%A1%E3%83%A2.md?ref=feat%2Fx'
  );
  assert.equal(req.headers.Authorization, undefined);
});

const items = [
  { title: 'git 状態を確認', tags: ['git'], body: 'git status -sb' },
  { title: 'コードレビュー依頼', tags: ['prompt', 'review'], body: '差分をレビュー' },
  { title: '掃除', tags: ['cleanup'], body: 'Remove-Item -WhatIf' },
];

test('空の検索語では全件を元の順で返す', () => {
  assert.deepEqual(filterSnippets(items, '  '), items);
});

test('タイトル・タグ・本文の部分一致で、全角や大文字も区別しない', () => {
  assert.deepEqual(filterSnippets(items, 'ＧＩＴ').map((x) => x.title), ['git 状態を確認']);
  assert.deepEqual(filterSnippets(items, 'review').map((x) => x.title), ['コードレビュー依頼']);
  assert.deepEqual(filterSnippets(items, 'whatif').map((x) => x.title), ['掃除']);
});

test('複数の語はすべて含む件だけを返し、タイトルに当たる件を先にする', () => {
  assert.deepEqual(filterSnippets(items, 'レビュー 差分').map((x) => x.title), ['コードレビュー依頼']);
  const list = [
    { title: 'a', tags: [], body: 'zip' },
    { title: 'zip b', tags: [], body: '' },
  ];
  assert.deepEqual(filterSnippets(list, 'zip').map((x) => x.title), ['zip b', 'a']);
});
