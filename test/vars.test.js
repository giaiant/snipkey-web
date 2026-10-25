'use strict';
// 実行: node --test web/test/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { extractVariables, substitutePaste, substituteRun, runValueError } = require('../vars.js');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'spec', 'fixtures', 'variables.json'), 'utf8'));

fixture.extract.forEach((c, i) => {
  test('variables.json extract[' + i + '] の変数を取り出す', () => {
    assert.deepEqual(extractVariables(c.body), c.vars);
  });
});

fixture.paste.forEach((c, i) => {
  test('variables.json paste[' + i + '] を置き換える', () => {
    assert.equal(substitutePaste(c.body, c.values), c.out);
  });
});

fixture.run.forEach((c, i) => {
  test('variables.json run[' + i + ']（' + c.shell + '）を置き換える', () => {
    assert.equal(substituteRun(c.body, c.values, c.shell), c.out);
  });
});

test('paste で値が無い名前は既定値を使う', () => {
  assert.equal(substitutePaste('{{a:x}} {{b}}', {}), 'x ');
});

test('値の $ や $& は置き換えの記号として読まない', () => {
  assert.equal(substitutePaste('[{{a}}]', { a: "$& $1 $$ $'" }), "[$& $1 $$ $']");
  assert.equal(substituteRun('echo "{{a}}"', { a: '$&' }, 'powershell'), "$snipkeyVar1 = '$&'\necho \"$($snipkeyVar1)\"");
});

test('run の値に改行があればエラーにする', () => {
  assert.equal(runValueError('echo {{a}} {{b}}', { a: 'x', b: '1\n2' }), 'b');
  assert.equal(runValueError('echo {{a}}', { a: 'x' }), null);
  assert.throws(() => substituteRun('echo {{a}}', { a: '1\r\n2' }, 'cmd'), /改行/);
});

test('shell が決まっていない値なら powershell として扱う', () => {
  assert.equal(substituteRun('echo {{a}}', { a: 'x' }, 'bash'), "$snipkeyVar1 = 'x'\necho $($snipkeyVar1)");
});
