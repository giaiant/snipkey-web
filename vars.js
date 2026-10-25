// snipkey: 本文の変数 {{名前}}・{{名前:既定値}} の取り出しと置き換え（SPEC.md の「変数」）。
// ブラウザでは window.SnipkeyVars、Node では require('./vars.js') で使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipkeyVars = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const PATTERN = /\{\{([^{}\n]*)\}\}/g;

  // {{ }} の中身を { name, default } にする。変数にならない時は null
  function parseInner(inner) {
    const i = inner.indexOf(':');
    const name = (i < 0 ? inner : inner.slice(0, i)).trim();
    if (name === '') return null;
    return { name: name, default: i < 0 ? '' : inner.slice(i + 1).trim() };
  }

  // 本文に最初に出てくる順で、変数を1つずつ返す。同じ名前の既定値は最初のもの。[{ name, default }]
  function extractVariables(body) {
    const out = [];
    const seen = new Set();
    for (const m of String(body).matchAll(PATTERN)) {
      const v = parseInner(m[1]);
      if (!v || seen.has(v.name)) continue;
      seen.add(v.name);
      out.push(v);
    }
    return out;
  }

  // 値が無い名前は既定値を使う
  function valueOf(values, v, defaults) {
    if (values && Object.prototype.hasOwnProperty.call(values, v.name)) return String(values[v.name]);
    return defaults.get(v.name);
  }

  // 変数を fn(変数, 何番目か（1から）) の結果に置き換える。変数にならない {{…}} はそのまま残す
  function replaceVariables(body, fn) {
    const index = new Map(extractVariables(body).map((v, i) => [v.name, i + 1]));
    return String(body).replace(PATTERN, (m, inner) => {
      const v = parseInner(inner);
      return v ? fn(v, index.get(v.name)) : m;
    });
  }

  // paste：本文の文字を、そのまま値に置き換える
  function substitutePaste(body, values) {
    const defaults = new Map(extractVariables(body).map((v) => [v.name, v.default]));
    return replaceVariables(body, (v) => valueOf(values, v, defaults));
  }

  // run の値に使えないもの（改行）を調べる。問題が無ければ null、あれば変数の名前
  function runValueError(body, values) {
    const vars = extractVariables(body);
    const defaults = new Map(vars.map((v) => [v.name, v.default]));
    const bad = vars.find((v) => /[\r\n]/.test(valueOf(values, v, defaults)));
    return bad ? bad.name : null;
  }

  // run：値をシェルの変数として先頭で定義し、本文ではそれを参照する。変数が無ければ本文のまま。
  // shell は powershell（既定）・pwsh・cmd。値に改行があれば Error を投げる
  function substituteRun(body, values, shell) {
    const vars = extractVariables(body);
    if (vars.length === 0) return String(body);
    const bad = runValueError(body, values);
    if (bad !== null) throw new Error('「' + bad + '」の値に改行は入れられません（run）');
    const defaults = new Map(vars.map((v) => [v.name, v.default]));
    const cmd = shell === 'cmd';
    const head = vars.map((v, i) => {
      const val = valueOf(values, v, defaults);
      return cmd
        ? 'set "SNIPKEY_VAR' + (i + 1) + '=' + val.replace(/%/g, '%%') + '"'
        : '$snipkeyVar' + (i + 1) + " = '" + val.replace(/'/g, "''") + "'";
    });
    const text = replaceVariables(body, (v, n) => (cmd ? '%SNIPKEY_VAR' + n + '%' : '$($snipkeyVar' + n + ')'));
    return head.join('\n') + '\n' + text;
  }

  return {
    extractVariables: extractVariables,
    substitutePaste: substitutePaste,
    substituteRun: substituteRun,
    runValueError: runValueError,
  };
});
