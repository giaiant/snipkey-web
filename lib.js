// snipkey: 画面に依存しない処理（GitHub への要求の組み立て・検索）。
// ブラウザでは window.SnipkeyLib、Node では require('./lib.js') で使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipkeyLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = { owner: 'giaiant', repo: 'snipkey', branch: 'main', path: 'data/snippets.md' };

  const COMMIT_MESSAGE = 'data: update snippets from web';

  const enc = (v) => encodeURIComponent(String(v).trim());

  function contentsUrl(s) {
    const filePath = String(s.path).trim().replace(/^\/+/, '').split('/').map(enc).join('/');
    return 'https://api.github.com/repos/' + enc(s.owner) + '/' + enc(s.repo) + '/contents/' + filePath;
  }

  function apiHeaders(accept, token) {
    const headers = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
  }

  // GitHub Contents API で生の本文を取る要求。token は呼び出し側が渡すだけで、ここでは保存しない。
  function buildContentsRequest(settings, token) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings);
    return { url: contentsUrl(s) + '?ref=' + enc(s.branch), headers: apiHeaders('application/vnd.github.raw', token) };
  }

  // 本文と sha を JSON で取る要求（保存の時に sha が要る）
  function buildReadRequest(settings, token) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings);
    return { url: contentsUrl(s) + '?ref=' + enc(s.branch), headers: apiHeaders('application/vnd.github+json', token) };
  }

  // 本文を書き込む要求。sha は最後に読んだもの（ほかで更新されていれば GitHub が 409 を返す）
  function buildWriteRequest(settings, token, text, sha) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings);
    const body = { message: COMMIT_MESSAGE, content: encodeBase64Utf8(text), branch: String(s.branch).trim() };
    if (sha) body.sha = sha;
    const headers = apiHeaders('application/vnd.github+json', token);
    headers['Content-Type'] = 'application/json';
    return { url: contentsUrl(s), method: 'PUT', headers: headers, body: JSON.stringify(body) };
  }

  function encodeBase64Utf8(text) {
    const bytes = new TextEncoder().encode(String(text));
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  function decodeBase64Utf8(b64) {
    const bin = atob(String(b64).replace(/\s+/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // Contents API の JSON から { text, sha } を取り出す。1MB を超えて本文が入っていない時は text が null
  function readContentsJson(json) {
    if (!json || typeof json.sha !== 'string') throw new Error('GitHub の応答の形が想定と違います');
    const text = json.encoding === 'base64' && typeof json.content === 'string' ? decodeBase64Utf8(json.content) : null;
    return { text: text, sha: json.sha };
  }

  function describeHttpError(status) {
    if (status === 401) return 'PAT が無効か期限切れです（401）';
    if (status === 403) return 'アクセスが拒否されました。PAT の権限か回数制限を確認してください（403）';
    if (status === 404) return 'ファイルが見つかりません。owner・repo・branch・path と PAT の対象リポジトリを確認してください（404）';
    return 'GitHub から読めませんでした（HTTP ' + status + '）';
  }

  // 書き込みの失敗を分類する。kind: conflict（sha 不一致）| forbidden | auth | notfound | other
  function classifyWriteError(status, apiMessage) {
    const m = String(apiMessage || '');
    if (status === 409 || (status === 422 && /sha/i.test(m))) {
      return { kind: 'conflict', message: 'ほかの場所で先に更新されていました（' + status + '）' };
    }
    if (status === 403) {
      return { kind: 'forbidden', message: '書き込みが拒否されました。編集には Contents: Read and write の権限を持つ PAT が必要です。読み取り専用の PAT なら作り直してください（403）' };
    }
    if (status === 401) return { kind: 'auth', message: 'PAT が無効か期限切れです（401）' };
    if (status === 404) return { kind: 'notfound', message: '書き込み先が見つかりません。owner・repo・branch・path と PAT の対象リポジトリを確認してください（404）' };
    return { kind: 'other', message: '保存できませんでした（HTTP ' + status + (m ? '：' + m : '') + '）' };
  }

  // 全角・半角や大文字・小文字の違いを吸収する
  function normalize(s) {
    return String(s).normalize('NFKC').toLowerCase();
  }

  // 空白で区切った語をすべて含む件を返す（タイトル・タグ・本文の部分一致）。
  // タイトルに当たる件を先に、同じ順位の中では元の順を保つ。
  function filterSnippets(items, query) {
    const terms = normalize(query).split(/\s+/).filter(Boolean);
    if (terms.length === 0) return items.slice();
    const scored = [];
    items.forEach((it, i) => {
      const title = normalize(it.title);
      const tags = normalize(it.tags.join(' '));
      const body = normalize(it.body);
      let score = 0;
      for (const t of terms) {
        if (title.includes(t)) score += 3;
        else if (tags.includes(t)) score += 2;
        else if (body.includes(t)) score += 1;
        else return;
      }
      scored.push({ it: it, i: i, score: score });
    });
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    return scored.map((x) => x.it);
  }

  return {
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    COMMIT_MESSAGE: COMMIT_MESSAGE,
    buildContentsRequest: buildContentsRequest,
    buildReadRequest: buildReadRequest,
    buildWriteRequest: buildWriteRequest,
    encodeBase64Utf8: encodeBase64Utf8,
    decodeBase64Utf8: decodeBase64Utf8,
    readContentsJson: readContentsJson,
    describeHttpError: describeHttpError,
    classifyWriteError: classifyWriteError,
    filterSnippets: filterSnippets,
  };
});
