'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCategories, setCategories, categoryNameError, parseSnippets, serializeSnippets, extractPreamble } = require('../parser.js');

const PRE = '# snipkey snippets\n\nこの下に `## タイトル` で1件ずつ追加する。\n\n' +
  '<!-- snipkey:categories\nプロンプト: Sプロンプト, Lプロンプト\n運用: コマンド, クリーンアップ, 自動化, 夜間\n-->\n\n最後の行\n';

test('塊を読む：順番どおり、1行が1カテゴリ', () => {
  assert.deepEqual(parseCategories(PRE), [
    { name: 'プロンプト', tags: ['Sプロンプト', 'Lプロンプト'] },
    { name: '運用', tags: ['コマンド', 'クリーンアップ', '自動化', '夜間'] },
  ]);
});

test('読み書きの往復：書いた塊を読むと同じになり、説明文のほかの部分は変わらない', () => {
  const cats = [
    { name: '運用', tags: ['コマンド', '夜間'] },
    { name: 'プロンプト', tags: ['Lプロンプト'] },
    { name: '空', tags: [] },
  ];
  const out = setCategories(PRE, cats);
  assert.deepEqual(parseCategories(out), cats);
  const strip = (s) => s.replace(/<!--[\s\S]*?-->/, '<BLOCK>');
  assert.equal(strip(out), strip(PRE));
  assert.equal(setCategories(out, parseCategories(out)), out); // 2回目は変わらない
});

test('塊が無い場合：読むと空、書くと末尾に足す。空にすると塊を消す', () => {
  const plain = '# t\n\nmemo\n';
  assert.deepEqual(parseCategories(plain), []);
  assert.deepEqual(parseCategories(''), []);
  assert.deepEqual(parseCategories(null), []);
  const added = setCategories(plain, [{ name: 'A', tags: ['x'] }]);
  assert.equal(added, '# t\n\nmemo\n\n<!-- snipkey:categories\nA: x\n-->\n');
  assert.equal(setCategories(added, []), '# t\n\nmemo\n');
  assert.equal(setCategories(plain, []), plain);
  assert.equal(setCategories('', [{ name: 'A', tags: [] }]), '<!-- snipkey:categories\nA: \n-->\n');
});

test('空行・前後の空白・CRLF・全角の区切りを受け付ける', () => {
  const pre = '<!--   snipkey:categories  \r\n\r\n   プロンプト ：  Sプロンプト ,Lプロンプト ,  \r\n\r\n  運用:コマンド，夜間、自動化\r\n-->\r\n';
  assert.deepEqual(parseCategories(pre), [
    { name: 'プロンプト', tags: ['Sプロンプト', 'Lプロンプト'] },
    { name: '運用', tags: ['コマンド', '夜間', '自動化'] },
  ]);
});

test('不正な行は無視する：「:」が無い・名前が空・同じ名前の2回目・同じタグの重複', () => {
  const pre = '<!-- snipkey:categories\nこれは説明\n: タグだけ\nA: x, x, y\nA: z\n#B: x\nB: \n-->';
  assert.deepEqual(parseCategories(pre), [{ name: 'A', tags: ['x', 'y'] }, { name: 'B', tags: [] }]);
});

test('ほかの HTML コメントや、閉じていない塊は読まない', () => {
  assert.deepEqual(parseCategories('<!-- memo\nA: x\n-->'), []);
  assert.deepEqual(parseCategories('<!-- snipkey:categories\nA: x\n'), []);
});

test('書けない名前とタグは例外にする', () => {
  assert.equal(categoryNameError('ふつう'), '');
  assert.match(categoryNameError(' '), /空/);
  assert.match(categoryNameError('a:b'), /「:」/);
  assert.match(categoryNameError('#a'), /#/);
  assert.match(categoryNameError('a--b'), /--/);
  assert.throws(() => setCategories('', [{ name: 'a,b', tags: [] }]));
  assert.throws(() => setCategories('', [{ name: 'a', tags: ['x-->'] }]));
});

test('塊は snippets の読み書きに影響しない', () => {
  const md = PRE + '\n## A\ntype: paste\ntags: 夜間\n\n~~~\na\n~~~\n';
  const items = parseSnippets(md);
  assert.deepEqual(items.map((it) => it.title), ['A']);
  const pre2 = setCategories(extractPreamble(md), [{ name: '運用', tags: ['夜間'] }]);
  const out = serializeSnippets(items, pre2);
  assert.deepEqual(parseSnippets(out), items);
  assert.deepEqual(parseCategories(extractPreamble(out)), [{ name: '運用', tags: ['夜間'] }]);
  assert.ok(extractPreamble(out).includes('最後の行'));
});
