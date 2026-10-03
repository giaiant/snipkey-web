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

// ---- 書き込み ----
const lib = require('../lib.js');

test('読む要求は JSON（sha を得るため）', () => {
  const req = lib.buildReadRequest(DEFAULT_SETTINGS, 'TOKEN');
  assert.equal(req.url, 'https://api.github.com/repos/giaiant/snipkey/contents/data/snippets.md?ref=main');
  assert.equal(req.headers.Accept, 'application/vnd.github+json');
});

test('書く要求は PUT で、sha・branch・決まったコミットメッセージを付ける', () => {
  const req = lib.buildWriteRequest(DEFAULT_SETTINGS, 'TOKEN', '## あ\n', 'abc123');
  assert.equal(req.method, 'PUT');
  assert.equal(req.url, 'https://api.github.com/repos/giaiant/snipkey/contents/data/snippets.md');
  assert.equal(req.headers.Authorization, 'Bearer TOKEN');
  const body = JSON.parse(req.body);
  assert.deepEqual(Object.keys(body).sort(), ['branch', 'content', 'message', 'sha']);
  assert.equal(body.message, 'data: update snippets from web');
  assert.equal(body.sha, 'abc123');
  assert.equal(body.branch, 'main');
  assert.equal(Buffer.from(body.content, 'base64').toString('utf8'), '## あ\n');
});

test('base64 は UTF-8 で往復でき、GitHub の改行入りも読める', () => {
  const s = '日本語 ``` ~~~ 😀\n' + 'x'.repeat(70000);
  const b64 = lib.encodeBase64Utf8(s);
  assert.equal(b64, Buffer.from(s, 'utf8').toString('base64'));
  const wrapped = b64.replace(/(.{60})/g, '$1\n');
  assert.equal(lib.decodeBase64Utf8(wrapped), s);
  assert.deepEqual(lib.readContentsJson({ sha: 'z', encoding: 'base64', content: wrapped }), { text: s, sha: 'z' });
  assert.deepEqual(lib.readContentsJson({ sha: 'z', encoding: 'none', content: '' }), { text: null, sha: 'z' });
  assert.throws(() => lib.readContentsJson({}));
});

test('書き込みの失敗を分類する', () => {
  assert.equal(lib.classifyWriteError(409, 'x does not match y').kind, 'conflict');
  assert.equal(lib.classifyWriteError(422, '"sha" wasn\'t supplied.').kind, 'conflict');
  assert.equal(lib.classifyWriteError(422, 'Invalid request').kind, 'other');
  const f = lib.classifyWriteError(403, 'Resource not accessible by personal access token');
  assert.equal(f.kind, 'forbidden');
  assert.match(f.message, /Read and write/);
  assert.equal(lib.classifyWriteError(401).kind, 'auth');
  assert.equal(lib.classifyWriteError(404).kind, 'notfound');
  assert.equal(lib.classifyWriteError(500).kind, 'other');
});
