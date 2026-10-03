// snipkey PWA 本体。読み込みは起動時に1回と「更新」ボタンだけ（定期的なポーリングはしない）。
(function () {
  'use strict';

  const { parseSnippets } = window.SnipkeyParser;
  const { DEFAULT_SETTINGS, buildContentsRequest, describeHttpError, filterSnippets } = window.SnipkeyLib;

  const KEY_SETTINGS = 'snipkey.settings';
  const KEY_TOKEN = 'snipkey.token';
  const KEY_CACHE = 'snipkey.cache';

  // 開発用のローカル読み込みは、ローカルの開発サーバで開いた時だけ選べる
  const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), statusText: $('status-text'), notice: $('notice'),
    list: $('list'), empty: $('empty'), toast: $('toast'),
    q: $('q'), clear: $('clear'), refresh: $('refresh'),
    openSettings: $('open-settings'), dialog: $('settings'), form: $('settings-form'),
    tokenState: $('token-state'), forgetToken: $('forget-token'), cancel: $('cancel-settings'),
    devRow: $('dev-row'),
  };

  let items = [];
  let loading = false;

  // ---- 保存 ----
  function readJson(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; }
  }
  function write(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
      return true;
    } catch (_) { return false; }
  }
  function getSettings() {
    return Object.assign({}, DEFAULT_SETTINGS, { devLocal: false }, readJson(KEY_SETTINGS));
  }
  function getToken() {
    try { return localStorage.getItem(KEY_TOKEN) || ''; } catch (_) { return ''; }
  }
  function useDevLocal(s) { return DEV_HOST && s.devLocal === true; }
  function sourceLabel(s) {
    return useDevLocal(s) ? 'ローカル（開発用）' : s.owner + '/' + s.repo + '@' + s.branch;
  }

  // ---- 表示 ----
  function fmtTime(ms) {
    return new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function setStatus(text, offline) {
    els.statusText.textContent = text;
    els.status.classList.toggle('offline', !!offline);
  }
  function showNotice(text, withSettingsButton) {
    els.notice.textContent = text;
    if (withSettingsButton) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn primary small'; b.textContent = '設定を開く';
      b.addEventListener('click', openSettings);
      els.notice.append(document.createElement('br'), b);
    }
    els.notice.hidden = false;
  }
  function hideNotice() { els.notice.hidden = true; els.notice.textContent = ''; }

  let toastTimer = 0;
  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 4000 : 1800);
  }

  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

  function renderItem(it) {
    const li = document.createElement('li');
    li.className = 'item';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'copy';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = it.title;
    const meta = document.createElement('div');
    meta.className = 'meta';
    if (it.type === 'run') {
      const run = document.createElement('span');
      run.className = 'chip run';
      run.textContent = '▶ run';
      run.title = 'Windows では実行するコマンド。ここではコピーだけ';
      meta.append(run);
    }
    for (const t of it.tags) {
      const c = document.createElement('span');
      c.className = 'chip';
      c.textContent = '#' + t;
      meta.append(c);
    }
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.textContent = it.body;
    copyBtn.append(title);
    if (meta.childElementCount) copyBtn.append(meta);
    copyBtn.append(preview);
    copyBtn.setAttribute('aria-label', it.title + ' をコピー' + (it.type === 'run' ? '（run・実行はしません）' : ''));
    copyBtn.addEventListener('click', () => copySnippet(it));

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand';
    expand.setAttribute('aria-expanded', 'false');
    expand.setAttribute('aria-label', it.title + ' の全文を表示');
    expand.innerHTML = CHEVRON;

    let full = null;
    expand.addEventListener('click', () => {
      const open = expand.getAttribute('aria-expanded') !== 'true';
      expand.setAttribute('aria-expanded', String(open));
      if (open && !full) {
        full = document.createElement('div');
        full.className = 'full';
        const pre = document.createElement('div');
        pre.textContent = it.body;
        const actions = document.createElement('div');
        actions.className = 'full-actions';
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn primary small'; b.textContent = '全文をコピー';
        b.addEventListener('click', () => copySnippet(it));
        actions.append(b);
        full.append(pre, actions);
        li.append(full);
      }
      if (full) full.hidden = !open;
    });

    li.append(copyBtn, expand);
    return li;
  }

  function render() {
    const q = els.q.value;
    els.clear.hidden = q === '';
    const shown = filterSnippets(items, q);
    els.list.replaceChildren(...shown.map(renderItem));
    if (items.length === 0) {
      els.empty.hidden = true;
    } else if (shown.length === 0) {
      els.empty.textContent = '「' + q.trim() + '」に当たる件はありません';
      els.empty.hidden = false;
    } else {
      els.empty.hidden = true;
    }
  }

  // ---- コピー ----
  async function writeClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 下の方法を試す */ }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    return ok;
  }
  async function copySnippet(it) {
    const ok = await writeClipboard(it.body);
    if (!ok) { toast('コピーできませんでした', true); return; }
    if (navigator.vibrate) navigator.vibrate(15);
    toast(it.type === 'run'
      ? 'コマンドをコピーしました（実行はしません）：' + it.title
      : 'コピーしました：' + it.title);
  }

  // ---- 読み込み ----
  function applyText(text) {
    items = parseSnippets(text);
    render();
  }

  function showCache(reason) {
    const cache = readJson(KEY_CACHE);
    if (cache && typeof cache.text === 'string') {
      applyText(cache.text);
      const head = reason ? '保存分を表示 · ' : '';
      setStatus(head + fmtTime(cache.fetchedAt) + ' の ' + items.length + ' 件 · ' + cache.source, !!reason);
      els.status.title = reason;
      return true;
    }
    return false;
  }

  async function fetchText(s) {
    if (useDevLocal(s)) {
      const url = new URL('../' + String(s.path).replace(/^\/+/, ''), location.href);
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error('ローカルファイルを読めません（HTTP ' + res.status + '）');
      return res.text();
    }
    const token = getToken();
    if (!token) {
      const e = new Error('PAT が未設定です');
      e.needsSettings = true;
      throw e;
    }
    const req = buildContentsRequest(s, token);
    const res = await fetch(req.url, { headers: req.headers, cache: 'no-store' });
    if (!res.ok) {
      const e = new Error(describeHttpError(res.status));
      e.needsSettings = res.status === 401 || res.status === 404;
      throw e;
    }
    return res.text();
  }

  async function load(manual) {
    if (loading) return;
    loading = true;
    els.refresh.classList.add('spin');
    els.refresh.disabled = true;
    const s = getSettings();
    try {
      const text = await fetchText(s);
      const fetchedAt = Date.now();
      applyText(text);
      hideNotice();
      const saved = write(KEY_CACHE, { text: text, fetchedAt: fetchedAt, source: sourceLabel(s) });
      setStatus(items.length + ' 件 · ' + sourceLabel(s) + ' · ' + fmtTime(fetchedAt) + ' 取得' + (saved ? '' : '（保存できません）'));
      els.status.title = '';
      if (manual) toast('更新しました（' + items.length + ' 件）');
      else if (els.toast.classList.contains('error')) els.toast.hidden = true;
    } catch (err) {
      const reason = err instanceof TypeError ? 'オフラインか接続できません' : err.message;
      const hadCache = showCache(reason);
      if (err.needsSettings) {
        showNotice(reason + '。設定で owner・repo・branch・path と PAT を確かめてください。', true);
      } else if (!hadCache) {
        showNotice(reason + '。まだ保存した内容がありません。接続してから「更新」を押してください。', false);
      }
      if (!hadCache) setStatus(reason, true);
      else toast(reason, true);
    } finally {
      loading = false;
      els.refresh.classList.remove('spin');
      els.refresh.disabled = false;
    }
  }

  // ---- 設定 ----
  function updateTokenState() {
    const has = getToken() !== '';
    els.tokenState.textContent = has
      ? 'PAT：保存済み（表示しません。変えるときだけ入力）'
      : 'PAT：未設定';
    els.forgetToken.hidden = !has;
  }
  function openSettings() {
    const s = getSettings();
    const f = els.form.elements;
    f.owner.value = s.owner; f.repo.value = s.repo; f.branch.value = s.branch; f.path.value = s.path;
    f.token.value = '';
    f.devLocal.checked = useDevLocal(s);
    els.devRow.hidden = !DEV_HOST;
    updateTokenState();
    els.dialog.showModal();
  }
  els.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = els.form.elements;
    const s = {
      owner: f.owner.value.trim(), repo: f.repo.value.trim(),
      branch: f.branch.value.trim(), path: f.path.value.trim(),
      devLocal: DEV_HOST && f.devLocal.checked,
    };
    write(KEY_SETTINGS, s);
    const token = f.token.value.trim();
    if (token) write(KEY_TOKEN, token);
    f.token.value = '';
    els.dialog.close();
    load();
  });
  els.forgetToken.addEventListener('click', () => {
    write(KEY_TOKEN, null);
    updateTokenState();
    toast('PAT を消しました');
  });
  els.cancel.addEventListener('click', () => { els.form.elements.token.value = ''; els.dialog.close(); });
  els.dialog.addEventListener('click', (ev) => { if (ev.target === els.dialog) els.dialog.close(); });
  els.openSettings.addEventListener('click', openSettings);

  // ---- 検索 ----
  els.q.addEventListener('input', render);
  els.q.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      const first = filterSnippets(items, els.q.value)[0];
      if (first) copySnippet(first);
      els.q.blur();
    }
  });
  els.clear.addEventListener('click', () => { els.q.value = ''; render(); els.q.focus(); });
  els.refresh.addEventListener('click', () => load(true));

  // ---- 起動 ----
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 無くても動く */ });
  }
  const s0 = getSettings();
  if (!showCache('')) setStatus('読み込み中…');
  if (!useDevLocal(s0) && !getToken() && !readJson(KEY_CACHE)) {
    setStatus('未設定');
    showNotice('はじめに設定で PAT を入力してください。', true);
  } else {
    load(); // 起動時に1回だけ
  }
})();
