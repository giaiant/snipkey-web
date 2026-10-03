// snipkey PWA 本体。読み込みは起動時に1回と「更新」ボタンだけ（定期的なポーリングはしない）。
// 編集は手元の下書き（localStorage に保持）に反映し、「保存」で GitHub Contents API にまとめて書き込む。
(function () {
  'use strict';

  const { parseSnippets, serializeSnippets, extractPreamble, validateSnippets } = window.SnipkeyParser;
  const L = window.SnipkeyLib;
  const { DEFAULT_SETTINGS, filterSnippets, countTags, existingTags } = L;

  const KEY_SETTINGS = 'snipkey.settings';
  const KEY_TOKEN = 'snipkey.token';
  const KEY_CACHE = 'snipkey.cache';
  const KEY_DRAFT = 'snipkey.draft';
  const KEY_TAGS = 'snipkey.tags';

  // 開発用のローカル読み書きは、ローカルの開発サーバで開いた時だけ選べる
  const DEV_HOST = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);

  const $ = (id) => document.getElementById(id);
  const els = {
    status: $('status'), statusText: $('status-text'), notice: $('notice'),
    list: $('list'), empty: $('empty'), toast: $('toast'),
    q: $('q'), clear: $('clear'), refresh: $('refresh'), add: $('add'),
    tagStrip: $('tag-strip'), activeTags: $('active-tags'),
    openSettings: $('open-settings'), dialog: $('settings'), form: $('settings-form'),
    tokenState: $('token-state'), forgetToken: $('forget-token'), cancel: $('cancel-settings'),
    devRow: $('dev-row'),
    draftBar: $('draft-bar'), draftText: $('draft-text'), saveDraft: $('save-draft'), discardDraft: $('discard-draft'),
    editorPane: $('editor-pane'), editForm: $('edit-form'), editorTitle: $('editor-title'),
    editorBack: $('editor-back'), moveUp: $('move-up'), moveDown: $('move-down'),
    runFields: $('run-fields'), titleError: $('title-error'), bodyError: $('body-error'),
    deleteItem: $('delete-item'), cancelEdit: $('cancel-edit'), applyEdit: $('apply-edit'),
    confirm: $('confirm'), confirmText: $('confirm-text'), confirmYes: $('confirm-yes'), confirmNo: $('confirm-no'),
  };

  // remote：最後に読めた内容 { text, sha, items, preamble }
  // draft ：未保存の編集 { items, preamble, baseSha, baseText, conflict }（baseSha は編集の元にした版）
  let remote = { text: '', sha: null, items: [], preamble: '' };
  let draft = null;
  let editing = null; // { uid（新規は null）, snapshot }
  let viewLatest = false; // 食い違いの時に、最新の内容を見ているか
  let loading = false;
  let saving = false;
  let uidSeq = 0;
  let selectedTags = []; // 絞り込みに選んだタグ（localStorage に保つ。いまの件に無いタグは無視する）

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

  // ---- 読み書きの相手（GitHub か、開発サーバ） ----
  function fail(message, extra) {
    return Object.assign(new Error(message), extra || {});
  }
  async function errorMessageOf(res) {
    try { const j = await res.json(); return j && j.message ? String(j.message) : ''; } catch (_) { return ''; }
  }

  const devBackend = {
    url: () => new URL('../dev-api/data', location.href),
    async read() {
      const res = await fetch(this.url(), { cache: 'no-store' });
      if (!res.ok) throw fail('ローカルファイルを読めません（HTTP ' + res.status + '）。開発サーバ（web/tools/dev-server.js）で開いてください');
      const r = L.readContentsJson(await res.json());
      return { text: r.text || '', sha: r.sha };
    },
    async write(text, sha) {
      const res = await fetch(this.url(), {
        method: 'PUT', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: L.COMMIT_MESSAGE, content: L.encodeBase64Utf8(text), sha: sha || undefined }),
      });
      if (!res.ok) {
        const msg = await errorMessageOf(res);
        const c = L.classifyWriteError(res.status, msg);
        // 開発サーバの 403 は PAT ではなく起動の仕方の問題なので、サーバの説明を出す
        throw fail(res.status === 403 && msg ? msg + '（403）' : c.message, { kind: c.kind });
      }
      return { sha: (await res.json()).content.sha };
    },
  };

  function githubBackend(s) {
    function token() {
      const t = getToken();
      if (!t) throw fail('PAT が未設定です', { needsSettings: true, kind: 'auth' });
      return t;
    }
    return {
      async read() {
        const t = token();
        const req = L.buildReadRequest(s, t);
        const res = await fetch(req.url, { headers: req.headers, cache: 'no-store' });
        if (!res.ok) throw fail(L.describeHttpError(res.status), { needsSettings: res.status === 401 || res.status === 404 });
        const r = L.readContentsJson(await res.json());
        if (r.text === null) { // 1MB を超えると JSON に本文が入らないので、生の本文を取り直す
          const raw = L.buildContentsRequest(s, t);
          const res2 = await fetch(raw.url, { headers: raw.headers, cache: 'no-store' });
          if (!res2.ok) throw fail(L.describeHttpError(res2.status));
          r.text = await res2.text();
        }
        return r;
      },
      async write(text, sha) {
        const req = L.buildWriteRequest(s, token(), text, sha);
        const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body, cache: 'no-store' });
        if (!res.ok) {
          const c = L.classifyWriteError(res.status, await errorMessageOf(res));
          throw fail(c.message, { kind: c.kind, needsSettings: c.kind !== 'conflict' && c.kind !== 'other' });
        }
        return { sha: (await res.json()).content.sha };
      },
    };
  }

  function backendFor(s) { return useDevLocal(s) ? devBackend : githubBackend(s); }

  // ---- 件と下書き ----
  function withUid(it) { return Object.assign({}, it, { tags: it.tags.slice(), uid: ++uidSeq }); }

  function setRemote(text, sha) {
    remote = { text: text, sha: sha || null, items: parseSnippets(text).map(withUid), preamble: extractPreamble(text) };
  }

  function currentItems() {
    if (draft && !viewLatest) return draft.items;
    return remote.items;
  }

  function ensureDraft() {
    if (draft) return draft;
    draft = {
      items: remote.items.map((it) => Object.assign({}, it, { tags: it.tags.slice() })), // uid は同じものを使う
      preamble: remote.preamble,
      baseSha: remote.sha,
      baseText: remote.text,
      conflict: null,
    };
    return draft;
  }

  function persistDraft() {
    if (!draft) { write(KEY_DRAFT, null); return; }
    const ok = write(KEY_DRAFT, {
      items: draft.items.map(stripUid), preamble: draft.preamble,
      baseSha: draft.baseSha, baseText: draft.baseText, conflict: draft.conflict,
    });
    if (!ok) toast('下書きを端末に保存できません（このまま閉じると変更は消えます）', true);
  }
  function restoreDraft() {
    const d = readJson(KEY_DRAFT);
    if (!d || !Array.isArray(d.items)) return;
    draft = {
      items: d.items.map((it) => withUid(Object.assign({ tags: [] }, it))),
      preamble: String(d.preamble || ''),
      baseSha: d.baseSha || null,
      baseText: typeof d.baseText === 'string' ? d.baseText : null,
      conflict: Array.isArray(d.conflict) ? d.conflict : null,
    };
  }
  function stripUid(it) {
    const o = Object.assign({}, it);
    delete o.uid;
    return o;
  }
  function dropDraft() {
    draft = null;
    viewLatest = false;
    persistDraft();
  }

  function indexOfUid(list, uid) { return list.findIndex((it) => it.uid === uid); }

  // 前に読んだ版と最新の版で、変わった件のタイトルを並べる
  function diffTitles(before, after) {
    const key = (it) => JSON.stringify([it.type, it.tags, it.shell, it.confirm, it.window, it.body]);
    const a = new Map(before.map((it) => [it.title, key(it)]));
    const b = new Map(after.map((it) => [it.title, key(it)]));
    const out = [];
    for (const [t, k] of b) {
      if (!a.has(t)) out.push('追加：' + t);
      else if (a.get(t) !== k) out.push('変更：' + t);
    }
    for (const t of a.keys()) if (!b.has(t)) out.push('削除：' + t);
    return out;
  }

  // ---- 表示 ----
  function fmtTime(ms) {
    return new Date(ms).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function setStatus(text, offline) {
    els.statusText.textContent = text;
    els.status.classList.toggle('offline', !!offline);
  }
  function showNotice(text, withSettingsButton, extraButtons) {
    els.notice.replaceChildren();
    for (const line of String(text).split('\n')) {
      const p = document.createElement('p');
      p.textContent = line;
      els.notice.append(p);
    }
    const buttons = (extraButtons || []).slice();
    if (withSettingsButton) buttons.push({ label: '設定を開く', primary: true, onClick: openSettings });
    if (buttons.length) {
      const row = document.createElement('div');
      row.className = 'notice-actions';
      for (const def of buttons) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'btn small ' + (def.primary ? 'primary' : 'ghost'); b.textContent = def.label;
        b.addEventListener('click', def.onClick);
        row.append(b);
      }
      els.notice.append(row);
    }
    els.notice.hidden = false;
  }
  function hideNotice() { els.notice.hidden = true; els.notice.replaceChildren(); }

  let toastTimer = 0;
  function toast(text, isError) {
    els.toast.textContent = text;
    els.toast.classList.toggle('error', !!isError);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : 1800);
  }

  // 確認ダイアログ。既定のボタンは「やめる」
  function ask(text, yesLabel) {
    return new Promise((resolve) => {
      els.confirmText.textContent = text;
      els.confirmYes.textContent = yesLabel || 'OK';
      els.confirm.returnValue = '';
      els.confirm.addEventListener('close', () => resolve(els.confirm.returnValue === 'yes'), { once: true });
      els.confirm.showModal();
      els.confirmNo.focus();
    });
  }

  // ---- タグで絞り込む ----
  function activeTags() { return existingTags(currentItems(), selectedTags); }
  const sameTag = (a, b) => a.normalize('NFKC').toLowerCase() === b.normalize('NFKC').toLowerCase();

  function toggleTag(tag) {
    const now = activeTags();
    const next = now.some((t) => sameTag(t, tag)) ? now.filter((t) => !sameTag(t, tag)) : now.concat([tag]);
    setTags(next);
  }
  function setTags(tags) {
    selectedTags = tags;
    write(KEY_TAGS, tags.length ? tags : null);
    render();
  }

  function tagButton(tag, opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag' + (opts.className ? ' ' + opts.className : '');
    const on = activeTags().some((t) => sameTag(t, tag));
    b.setAttribute('aria-pressed', String(on));
    const label = document.createElement('span');
    label.textContent = '#' + tag;
    b.append(label);
    if (opts.count !== undefined) {
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = String(opts.count);
      b.append(n);
    }
    b.setAttribute('aria-label', opts.label || ('#' + tag + (on ? ' の絞り込みを外す' : ' で絞り込む')));
    // 件の中のタグを押しても、その件のコピーや展開は動かさない
    b.addEventListener('click', (ev) => { ev.stopPropagation(); ev.preventDefault(); toggleTag(tag); });
    b.addEventListener('keydown', (ev) => ev.stopPropagation());
    return b;
  }

  function renderTagStrip() {
    const tags = countTags(currentItems());
    els.tagStrip.hidden = tags.length === 0;
    els.tagStrip.replaceChildren(...tags.map((x) => tagButton(x.tag, { count: x.count })));
  }

  function renderActiveTags() {
    const tags = activeTags();
    els.activeTags.hidden = tags.length === 0;
    document.body.classList.toggle('tag-filter', tags.length > 0);
    const chips = tags.map((t) => {
      const b = tagButton(t, { className: 'active', label: '#' + t + ' の絞り込みを外す' });
      b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17"/></svg>');
      return b;
    });
    if (tags.length > 1) {
      const all = document.createElement('button');
      all.type = 'button';
      all.className = 'tag clear-tags';
      all.textContent = 'すべて外す';
      all.addEventListener('click', () => setTags([]));
      chips.push(all);
    }
    els.activeTags.replaceChildren(...chips);
  }

  const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';
  const PENCIL = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/></svg>';

  function renderItem(it) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.uid = String(it.uid);
    if (editing && editing.uid === it.uid) li.classList.add('editing');

    // 中にタグのボタンを置くため、コピーの領域は button ではなく role=button の div にする
    const copyBtn = document.createElement('div');
    copyBtn.className = 'copy';
    copyBtn.setAttribute('role', 'button');
    copyBtn.tabIndex = 0;
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
    for (const t of it.tags) meta.append(tagButton(t, {}));
    const preview = document.createElement('div');
    preview.className = 'preview';
    preview.textContent = it.body;
    copyBtn.append(title);
    if (meta.childElementCount) copyBtn.append(meta);
    copyBtn.append(preview);
    copyBtn.setAttribute('aria-label', it.title + ' をコピー' + (it.type === 'run' ? '（run・実行はしません）' : ''));
    copyBtn.addEventListener('click', () => copySnippet(it));
    copyBtn.addEventListener('keydown', (ev) => {
      if (ev.target === copyBtn && (ev.key === 'Enter' || ev.key === ' ')) { ev.preventDefault(); copySnippet(it); }
    });

    const side = document.createElement('div');
    side.className = 'side';
    if (!viewLatest) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'edit';
      edit.setAttribute('aria-label', it.title + ' を編集');
      edit.title = '編集';
      edit.innerHTML = PENCIL;
      edit.addEventListener('click', () => openEditor(it.uid));
      side.append(edit);
    }

    const expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'expand';
    expand.setAttribute('aria-expanded', 'false');
    expand.setAttribute('aria-label', it.title + ' の全文を表示');
    expand.innerHTML = CHEVRON;
    side.append(expand);

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

    li.append(copyBtn, side);
    return li;
  }

  function renderDraftBar() {
    els.draftBar.hidden = !draft;
    if (!draft) return;
    els.draftBar.classList.toggle('conflict', !!draft.conflict);
    if (viewLatest) els.draftText.textContent = '最新の内容を表示中（手元の変更は残っています）';
    else if (draft.conflict) els.draftText.textContent = '最新と食い違っています。確かめてから保存してください';
    else els.draftText.textContent = '未保存の変更があります';
    els.saveDraft.hidden = viewLatest;
    els.discardDraft.textContent = viewLatest ? '手元の変更に戻る' : '破棄';
  }

  function render() {
    const q = els.q.value;
    els.clear.hidden = q === '';
    const all = currentItems();
    const tags = activeTags();
    const shown = filterSnippets(all, q, tags);
    els.list.replaceChildren(...shown.map(renderItem));
    renderTagStrip();
    renderActiveTags();
    if (all.length === 0) {
      els.empty.textContent = draft || remote.text ? 'まだ1件もありません。＋で追加できます' : '';
      els.empty.hidden = els.empty.textContent === '';
    } else if (shown.length === 0) {
      const cond = tags.map((t) => '#' + t).concat(q.trim() ? ['「' + q.trim() + '」'] : []);
      els.empty.textContent = cond.join(' と ') + ' に当たる件はありません';
      els.empty.hidden = false;
    } else {
      els.empty.hidden = true;
    }
    renderDraftBar();
    updateMoveButtons();
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
  function readyStatus(fetchedAt, source, note) {
    setStatus(currentItems().length + ' 件 · ' + source + ' · ' + fmtTime(fetchedAt) + ' 取得' + (note || ''));
  }

  function showCache(reason) {
    const cache = readJson(KEY_CACHE);
    if (cache && typeof cache.text === 'string') {
      setRemote(cache.text, cache.sha);
      render();
      const head = reason ? '保存分を表示 · ' : '';
      setStatus(head + fmtTime(cache.fetchedAt) + ' の ' + currentItems().length + ' 件 · ' + cache.source, !!reason);
      els.status.title = reason;
      return true;
    }
    return false;
  }

  function remember(text, sha, s) {
    const fetchedAt = Date.now();
    const saved = write(KEY_CACHE, { text: text, sha: sha, fetchedAt: fetchedAt, source: sourceLabel(s) });
    readyStatus(fetchedAt, sourceLabel(s), saved ? '' : '（保存できません）');
    els.status.title = '';
  }

  async function load(manual) {
    if (loading) return;
    loading = true;
    els.refresh.classList.add('spin');
    els.refresh.disabled = true;
    const s = getSettings();
    try {
      const r = await backendFor(s).read();
      setRemote(r.text, r.sha);
      render();
      if (!draft || !draft.conflict) hideNotice();
      remember(r.text, r.sha, s);
      if (manual) toast('更新しました（' + remote.items.length + ' 件）');
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

  // ---- 保存（GitHub へ書き込む） ----
  async function saveDraftNow() {
    if (!draft || saving) return;
    if (editing && formChanged()) {
      const go = await ask('編集中の内容はまだ一覧に反映していません（OK を押していません）。反映せずに保存しますか？', '反映せずに保存');
      if (!go) return;
    }
    const errors = validateSnippets(draft.items);
    if (errors.length) {
      const bad = draft.items[errors[0].index];
      toast((errors[0].index + 1) + '件目：' + errors[0].message + '。直してから保存してください', true);
      if (bad) openEditor(bad.uid);
      return;
    }
    let text;
    try { text = serializeSnippets(draft.items, draft.preamble); } catch (e) { toast(e.message, true); return; }

    const s = getSettings();
    saving = true;
    els.saveDraft.disabled = true;
    els.saveDraft.textContent = '保存中…';
    try {
      const r = await backendFor(s).write(text, draft.baseSha);
      setRemote(text, r.sha);
      dropDraft();
      if (editing) closeEditor();
      hideNotice();
      render();
      remember(text, r.sha, s);
      toast('保存しました（' + remote.items.length + ' 件）');
    } catch (err) {
      if (err.kind === 'conflict') {
        await handleConflict(s);
      } else if (err instanceof TypeError) {
        toast('オフラインか接続できません。変更は端末に残っています', true);
      } else {
        showNotice(err.message + '\n変更は端末に残っています。', !!err.needsSettings);
        toast(err.message, true);
      }
    } finally {
      saving = false;
      els.saveDraft.disabled = false;
      els.saveDraft.textContent = '保存';
    }
  }

  // sha が合わなかった：最新を読み直し、手元の変更はそのまま残して、やり直しを促す
  async function handleConflict(s) {
    let latest;
    try {
      latest = await backendFor(s).read();
    } catch (e) {
      const reason = e instanceof TypeError ? 'オフラインか接続できません' : e.message;
      showNotice('ほかの場所で先に更新されていたため保存できませんでした。最新を読み直せませんでした（' + reason + '）。変更は端末に残っています。「更新」を押してからもう一度保存してください。', false);
      return;
    }
    const before = draft.baseText != null ? parseSnippets(draft.baseText) : [];
    setRemote(latest.text, latest.sha);
    remember(latest.text, latest.sha, s);
    const changed = diffTitles(before, remote.items);
    draft.baseSha = latest.sha;
    draft.baseText = latest.text;
    draft.conflict = changed;
    persistDraft();
    render();
    showConflictNotice();
    toast('ほかの場所で先に更新されていました。保存していません', true);
  }

  function showConflictNotice() {
    if (!draft || !draft.conflict) return;
    const changed = draft.conflict;
    showNotice(
      'data/snippets.md が、ほかの場所（Windows の同期や別の端末）で先に更新されていたため、保存していません。最新を読み直しました。手元の変更は消えずに残っています。\n' +
      (changed.length ? '最新で変わった件：' + changed.join('、') + '\n' : '') +
      '「最新を見る」で中身を確かめ、残したい変更を手元にも入れてから、もう一度「保存」を押してください（保存すると手元の内容で上書きします）。手元の変更をやめるなら「破棄」。',
      false,
      [{ label: '最新を見る', onClick: () => { viewLatest = true; if (editing) closeEditor(); render(); } }]
    );
  }

  els.saveDraft.addEventListener('click', saveDraftNow);
  els.discardDraft.addEventListener('click', async () => {
    if (viewLatest) { viewLatest = false; render(); return; }
    const go = await ask('未保存の変更をすべて捨てて、最後に読んだ内容に戻しますか？', '破棄する');
    if (!go) return;
    if (editing) closeEditor();
    dropDraft();
    hideNotice();
    render();
    toast('変更を破棄しました');
  });

  // ---- 編集フォーム ----
  const F = els.editForm.elements;

  function formValues() {
    return {
      title: F.title.value.trim(),
      type: F.type.value === 'run' ? 'run' : 'paste',
      tags: F.tags.value.split(',').map((t) => t.trim()).filter(Boolean),
      shell: F.shell.value,
      confirm: F.confirm.checked,
      window: F.window.value,
      body: F.body.value.replace(/\r\n?/g, '\n'),
    };
  }
  function fillForm(it) {
    F.title.value = it.title;
    F.type.value = it.type;
    F.tags.value = it.tags.join(', ');
    F.shell.value = it.shell;
    F.confirm.checked = it.confirm !== false;
    F.window.value = it.window;
    F.body.value = it.body;
  }
  function formChanged() {
    return !!editing && JSON.stringify(formValues()) !== editing.snapshot;
  }

  // 編集中の件を差し替えた一覧で調べ、この件のエラーだけを出す
  function validateForm() {
    if (!editing) return true;
    const list = currentItems().slice();
    const v = formValues();
    let idx = editing.uid === null ? -1 : indexOfUid(list, editing.uid);
    if (idx < 0) { list.push(v); idx = list.length - 1; } else list[idx] = v;
    const errs = validateSnippets(list).filter((e) => e.index === idx);
    const t = errs.find((e) => e.field === 'title');
    const b = errs.find((e) => e.field === 'body');
    els.titleError.textContent = t ? t.message : '';
    els.titleError.hidden = !t;
    els.bodyError.textContent = b ? b.message : '';
    els.bodyError.hidden = !b;
    F.title.setAttribute('aria-invalid', String(!!t));
    F.body.setAttribute('aria-invalid', String(!!b));
    els.applyEdit.disabled = errs.length > 0;
    return errs.length === 0;
  }

  function updateRunFields() {
    els.runFields.hidden = F.type.value !== 'run';
  }

  function updateMoveButtons() {
    if (!editing) return;
    const list = currentItems();
    const idx = editing.uid === null ? -1 : indexOfUid(list, editing.uid);
    els.moveUp.disabled = idx <= 0;
    els.moveDown.disabled = idx < 0 || idx >= list.length - 1;
  }

  function openEditor(uid) {
    viewLatest = false;
    const list = currentItems();
    const it = uid === null ? null : list[indexOfUid(list, uid)];
    if (uid !== null && !it) return;
    fillForm(it || { title: '', type: 'paste', tags: [], shell: 'powershell', confirm: true, window: 'keep', body: '' });
    editing = { uid: it ? uid : null, snapshot: '' };
    editing.snapshot = JSON.stringify(formValues());
    els.editorTitle.textContent = it ? '編集' : '新規追加';
    els.deleteItem.hidden = !it;
    els.moveUp.hidden = !it;
    els.moveDown.hidden = !it;
    updateRunFields();
    validateForm();
    els.editorPane.hidden = false;
    document.body.classList.add('editing');
    if (!(history.state && history.state.snipkeyEditor)) history.pushState({ snipkeyEditor: true }, '');
    render();
    els.editorPane.scrollTop = 0;
    if (!it) F.title.focus();
    else if (window.matchMedia('(min-width: 900px)').matches) F.title.focus({ preventScroll: true });
    else window.scrollTo(0, 0);
  }

  function closeEditor(fromPop) {
    const uid = editing && editing.uid;
    editing = null;
    els.editorPane.hidden = true;
    document.body.classList.remove('editing');
    if (!fromPop && history.state && history.state.snipkeyEditor) history.back();
    render();
    // 一覧に戻った時、いま触った件が見えるようにする
    if (uid !== null && uid !== undefined) {
      const li = els.list.querySelector('[data-uid="' + uid + '"]');
      if (li) li.scrollIntoView({ block: 'nearest' });
    }
  }

  async function cancelEdit() {
    if (formChanged() && !(await ask('編集中の内容を捨てますか？', '捨てる'))) return;
    closeEditor();
  }

  els.editForm.addEventListener('input', () => { updateRunFields(); validateForm(); });
  els.editForm.addEventListener('change', () => { updateRunFields(); validateForm(); });
  els.editForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!editing || !validateForm()) return;
    if (!formChanged()) { closeEditor(); return; }
    const v = formValues();
    const d = ensureDraft();
    let uid = editing.uid;
    if (uid === null) {
      const it = withUid(v);
      d.items.push(it);
      uid = it.uid;
      editing.uid = uid; // 閉じた後にこの件を見せるため
    } else {
      const idx = indexOfUid(d.items, uid);
      if (idx < 0) { toast('編集していた件が見つかりません', true); closeEditor(); return; }
      Object.assign(d.items[idx], v);
    }
    persistDraft();
    closeEditor();
    toast('反映しました。「保存」で GitHub に書き込みます');
  });
  // 本文で Ctrl+Enter（Mac は ⌘+Enter）なら OK と同じ
  F.body.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); els.editForm.requestSubmit(); }
  });
  els.cancelEdit.addEventListener('click', cancelEdit);
  els.editorBack.addEventListener('click', cancelEdit);

  els.deleteItem.addEventListener('click', async () => {
    if (!editing || editing.uid === null) return;
    const list = currentItems();
    const it = list[indexOfUid(list, editing.uid)];
    if (!it) return;
    if (!(await ask('「' + it.title + '」を削除しますか？（「保存」を押すまで GitHub には書き込みません）', '削除する'))) return;
    const d = ensureDraft();
    const idx = indexOfUid(d.items, editing.uid);
    if (idx >= 0) d.items.splice(idx, 1);
    persistDraft();
    editing.uid = null;
    closeEditor();
    toast('削除しました：' + it.title + '（未保存）');
  });

  function move(delta) {
    if (!editing || editing.uid === null) return;
    const d = ensureDraft();
    const idx = indexOfUid(d.items, editing.uid);
    const to = idx + delta;
    if (idx < 0 || to < 0 || to >= d.items.length) return;
    const [it] = d.items.splice(idx, 1);
    d.items.splice(to, 0, it);
    persistDraft();
    render();
    const li = els.list.querySelector('[data-uid="' + editing.uid + '"]');
    if (li && window.matchMedia('(min-width: 900px)').matches) li.scrollIntoView({ block: 'nearest' });
    toast((to + 1) + ' 番目に移動しました（未保存）');
  }
  els.moveUp.addEventListener('click', () => move(-1));
  els.moveDown.addEventListener('click', () => move(1));

  els.add.addEventListener('click', () => openEditor(null));

  // スマホの「戻る」で編集を閉じる
  window.addEventListener('popstate', async () => {
    if (!editing) return;
    if (history.state && history.state.snipkeyEditor) return;
    if (formChanged()) {
      history.pushState({ snipkeyEditor: true }, '');
      if (!(await ask('編集中の内容を捨てますか？', '捨てる'))) return;
      closeEditor();
      return;
    }
    closeEditor(true);
  });

  // 閉じる前に、反映していない編集があれば知らせる（下書きは端末に残る）
  window.addEventListener('beforeunload', (ev) => {
    if (formChanged()) { ev.preventDefault(); ev.returnValue = ''; }
  });

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
      const first = filterSnippets(currentItems(), els.q.value, activeTags())[0];
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
  // 起動時に編集の履歴が残っていたら捨てる（再読み込みで編集画面は開かない）
  if (history.state && history.state.snipkeyEditor) history.replaceState(null, '');
  restoreDraft();
  const savedTags = readJson(KEY_TAGS);
  if (Array.isArray(savedTags)) selectedTags = savedTags.filter((t) => typeof t === 'string');
  const s0 = getSettings();
  if (!showCache('')) { render(); setStatus('読み込み中…'); }
  if (draft && draft.conflict) showConflictNotice();
  if (!useDevLocal(s0) && !getToken() && !readJson(KEY_CACHE)) {
    setStatus('未設定');
    showNotice('はじめに設定で PAT を入力してください。', true);
  } else {
    load(); // 起動時に1回だけ
  }
})();
