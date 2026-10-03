'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeSnippets, describeChanges } = require('../merge.js');
const { parseSnippets, serializeSnippets } = require('../parser.js');

const S = (title, body, extra) => Object.assign(
  { title: title, type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: body || title },
  extra || {}
);
// 手元の下書きは、base から作った件に baseTitle を持つ
const fromBase = (items) => items.map((it) => Object.assign({}, it, { baseTitle: it.title }));
const titles = (r) => r.items.map((it) => it.title);

const base = [S('A'), S('B'), S('C')];

test('双方で別の件を追加：両方とも残り、手元の件は手元での位置に入る', () => {
  const local = fromBase(base);
  local.splice(1, 0, Object.assign(S('L1'), { baseTitle: null })); // A の後ろ
  const remote = base.concat([S('ナイトシフト設計')]);
  const r = mergeSnippets({ base, local, remote });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(titles(r), ['A', 'L1', 'B', 'C', 'ナイトシフト設計']);
  assert.deepEqual(r.remoteChanges, ['追加：ナイトシフト設計']);
  assert.deepEqual(r.items.map((it) => it.baseTitle), ['A', null, 'B', 'C', 'ナイトシフト設計']);
});

test('先頭に足した件は先頭に入る', () => {
  const local = [Object.assign(S('L0'), { baseTitle: null })].concat(fromBase(base));
  const r = mergeSnippets({ base, local, remote: [S('Z')].concat(base) });
  assert.deepEqual(titles(r), ['Z', 'L0', 'A', 'B', 'C']);
});

test('手元で編集し、最新で追加：編集が当たり、追加も残る', () => {
  const local = fromBase(base);
  local[1] = Object.assign({}, local[1], { tags: ['Sプロンプト'] });
  const remote = base.concat([S('D')]);
  const r = mergeSnippets({ base, local, remote });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(titles(r), ['A', 'B', 'C', 'D']);
  assert.deepEqual(r.items[1].tags, ['Sプロンプト']);
});

test('手元で削除し、最新で編集：当たる件になり、選んだ方になる', () => {
  const local = fromBase(base).filter((it) => it.title !== 'B');
  const remote = [S('A'), S('B', 'B 改'), S('C')];
  const r = mergeSnippets({ base, local, remote });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'local-deleted-remote-modified');
  assert.equal(r.conflicts[0].key, 'B');
  assert.equal(r.conflicts[0].local, null);
  assert.equal(r.conflicts[0].remote.body, 'B 改');
  assert.deepEqual(titles(r), ['A', 'B', 'C']); // 選ぶまでは最新のまま
  assert.deepEqual(titles(mergeSnippets({ base, local, remote, choices: { B: 'local' } })), ['A', 'C']);
  const keep = mergeSnippets({ base, local, remote, choices: { B: 'remote' } });
  assert.deepEqual(keep.conflicts, []);
  assert.equal(keep.items[1].body, 'B 改');
});

test('手元で編集し、最新で削除：当たる件になり、手元を選ぶと手元の位置に戻る', () => {
  const local = fromBase(base);
  local[1] = Object.assign({}, local[1], { body: 'B 手元' });
  const remote = [S('A'), S('C')];
  const r = mergeSnippets({ base, local, remote });
  assert.equal(r.conflicts[0].kind, 'local-modified-remote-deleted');
  assert.deepEqual(titles(r), ['A', 'C']);
  assert.deepEqual(titles(mergeSnippets({ base, local, remote, choices: { B: 'local' } })), ['A', 'B', 'C']);
});

test('双方で同じ件を編集：当たる件になる', () => {
  const local = fromBase(base);
  local[0] = Object.assign({}, local[0], { body: 'A 手元' });
  const remote = [S('A', 'A 最新'), S('B'), S('C')];
  const r = mergeSnippets({ base, local, remote });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].kind, 'both-modified');
  assert.equal(r.items[0].body, 'A 最新');
  const chosen = mergeSnippets({ base, local, remote, choices: { A: 'local' } });
  assert.equal(chosen.items[0].body, 'A 手元');
  assert.deepEqual(chosen.remoteChanges, []); // 手元を選んだ件は「取り込んだ変更」に数えない
  assert.deepEqual(mergeSnippets({ base, local, remote, choices: { A: 'remote' } }).remoteChanges, ['変更：A']);
});

test('双方が同じ変更：当たらない', () => {
  const local = fromBase(base);
  local[0] = Object.assign({}, local[0], { body: 'A 同じ' });
  local.splice(2, 1); // C を削除
  const remote = [S('A', 'A 同じ'), S('B')];
  const r = mergeSnippets({ base, local, remote });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.items.map((it) => it.title + ':' + it.body), ['A:A 同じ', 'B:B']);
});

test('手元での改名：base との対応を保ち、最新でのほかの変更と合わせる', () => {
  const local = fromBase(base);
  local[1] = Object.assign({}, local[1], { title: 'B2' }); // baseTitle は B のまま
  const remote = [S('A', 'A 最新'), S('B'), S('C'), S('D')];
  const r = mergeSnippets({ base, local, remote });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(titles(r), ['A', 'B2', 'C', 'D']);
  assert.equal(r.items[0].body, 'A 最新');
  assert.equal(r.items[1].baseTitle, 'B'); // 合わせた後も最新の B と対応する
});

test('手元で改名し、最新で同じ件を編集：当たる件になる', () => {
  const local = fromBase(base);
  local[1] = Object.assign({}, local[1], { title: 'B2' });
  const remote = [S('A'), S('B', 'B 最新'), S('C')];
  const r = mergeSnippets({ base, local, remote });
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].key, 'B');
  assert.equal(r.conflicts[0].local.title, 'B2');
  assert.deepEqual(titles(mergeSnippets({ base, local, remote, choices: { B: 'local' } })), ['A', 'B2', 'C']);
});

test('baseTitle の無い古い下書きはタイトルで対応させる', () => {
  const local = [S('A', 'A 手元'), S('B'), S('C')];
  const r = mergeSnippets({ base, local, remote: base.concat([S('D')]) });
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.items.map((it) => it.title + ':' + it.body), ['A:A 手元', 'B:B', 'C:C', 'D:D']);
});

test('双方で同じタイトルの件を足した：同じなら1件、違えば当たる件', () => {
  const remote = base.concat([S('N', 'n')]);
  const same = mergeSnippets({ base, local: fromBase(base).concat([Object.assign(S('N', 'n'), { baseTitle: null })]), remote });
  assert.deepEqual(same.conflicts, []);
  assert.deepEqual(titles(same), ['A', 'B', 'C', 'N']);
  const diff = mergeSnippets({ base, local: fromBase(base).concat([Object.assign(S('N', 'x'), { baseTitle: null })]), remote });
  assert.equal(diff.conflicts[0].kind, 'both-added');
  assert.equal(mergeSnippets({ base, local: fromBase(base).concat([Object.assign(S('N', 'x'), { baseTitle: null })]), remote, choices: { 'added:N': 'local' } }).items[3].body, 'x');
});

test('説明文：片方だけの変更はそれを使い、両方で違えば選ばせる', () => {
  const args = { base, local: fromBase(base), remote: base, basePreamble: '# p' };
  assert.equal(mergeSnippets(Object.assign({}, args, { localPreamble: '# L', remotePreamble: '# p' })).preamble, '# L');
  assert.equal(mergeSnippets(Object.assign({}, args, { localPreamble: '# p', remotePreamble: '# R' })).preamble, '# R');
  const c = mergeSnippets(Object.assign({}, args, { localPreamble: '# L', remotePreamble: '# R' }));
  assert.deepEqual(c.preambleConflict, { local: '# L', remote: '# R' });
  assert.equal(mergeSnippets(Object.assign({}, args, { localPreamble: '# L', remotePreamble: '# R', preambleChoice: 'local' })).preamble, '# L');
});

test('実際の形式で：合わせた結果を書き出して読み直せる', () => {
  const baseText = '# head\n\n## A\ntype: paste\n\n~~~\na\n~~~\n\n## B\ntype: paste\ntags: x\n\n~~~\nb\n~~~\n';
  const remoteText = baseText + '\n## ナイトシフト設計\ntype: paste\ntags: Lプロンプト\n\n~~~\nnight\n~~~\n';
  const b = parseSnippets(baseText);
  const local = fromBase(b);
  local[1] = Object.assign({}, local[1], { tags: ['x', 'y'] });
  const r = mergeSnippets({ base: b, local, remote: parseSnippets(remoteText) });
  assert.deepEqual(r.conflicts, []);
  const out = parseSnippets(serializeSnippets(r.items, '# head'));
  assert.deepEqual(out.map((it) => it.title + ':' + it.tags.join('|')), ['A:', 'B:x|y', 'ナイトシフト設計:Lプロンプト']);
});

test('describeChanges は追加・変更・削除を返す', () => {
  assert.deepEqual(describeChanges(base, [S('A', 'x'), S('C'), S('D')]), ['変更：A', '追加：D', '削除：B']);
});
