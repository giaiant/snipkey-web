// snipkey: 画面に依存しない処理（GitHub への要求の組み立て・検索）。
// ブラウザでは window.SnipkeyLib、Node では require('./lib.js') で使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipkeyLib = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_SETTINGS = { owner: 'giaiant', repo: 'snipkey', branch: 'main', path: 'data/snippets.md' };

  // GitHub Contents API で生の本文を取る要求。token は呼び出し側が渡すだけで、ここでは保存しない。
  function buildContentsRequest(settings, token) {
    const s = Object.assign({}, DEFAULT_SETTINGS, settings);
    const enc = (v) => encodeURIComponent(String(v).trim());
    const filePath = String(s.path).trim().replace(/^\/+/, '').split('/').map(enc).join('/');
    const url = 'https://api.github.com/repos/' + enc(s.owner) + '/' + enc(s.repo) +
      '/contents/' + filePath + '?ref=' + enc(s.branch);
    const headers = {
      Accept: 'application/vnd.github.raw',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    return { url: url, headers: headers };
  }

  function describeHttpError(status) {
    if (status === 401) return 'PAT が無効か期限切れです（401）';
    if (status === 403) return 'アクセスが拒否されました。PAT の権限か回数制限を確認してください（403）';
    if (status === 404) return 'ファイルが見つかりません。owner・repo・branch・path と PAT の対象リポジトリを確認してください（404）';
    return 'GitHub から読めませんでした（HTTP ' + status + '）';
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
    buildContentsRequest: buildContentsRequest,
    describeHttpError: describeHttpError,
    filterSnippets: filterSnippets,
  };
});
