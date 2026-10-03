// snipkey PWA 本体。読み込みは起動時に1回と「更新」ボタンだけ（定期的なポーリングはしない）。
// 編集は手元の下書き（localStorage に保持）に反映し、「保存」で GitHub Contents API にまとめて書き込む。
(function () {
  'use strict';

  const { parseSnippets, serializeSnippets, extractPreamble, validateSnippets, parseCategories, setCategories, categoryNameError } = window.SnipkeyParser;
  const L = window.SnipkeyLib;
  const { mergeSnippets } = window.SnipkeyMerge;
  const { DEFAULT_SETTINGS, filterSnippets, countTags, existingTags } = L;

  const KEY_SETTINGS = 'snipkey.settings';
  const KEY_TOKEN = 'snipkey.token';
  const KEY_CACHE = 'snipkey.cache';
  const KEY_DRAFT = 'snipkey.draft';
  const KEY_TAGS = 'snipkey.tags';
  const KEY_CAT_OPEN = 'snipkey.category';

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
  // draft ：未保存の編集 { items, preamble, baseSha, baseText, pending }
  //   baseText・baseSha は編集の元にした版（最後に読んだ版。localStorage に残るので再読み込みの後も3者の比較に使える）
  //   items の各件は baseTitle（base でのタイトル。新しく足した件は null）を持ち、改名しても base との対応を保つ
  //   pending は、保存が食い違って、どちらを使うか選んでもらう間の最新 { text, sha }
  let remote = { text: '', sha: null, items: [], preamble: '' };
  let draft = null;
  let editing = null; // { uid（新規は null）, snapshot }
  let viewLatest = false; // 食い違いの時に、最新の内容を見ているか
  let loading = false;
  let saving = false;
  let uidSeq = 0;
  let selectedTags = []; // 絞り込みに選んだタグ（localStorage に保つ。いまの件に無いタグは無視する）
  let openCategory = null; // 開いているカテゴリ（localStorage に保つ。無くなったカテゴリなら閉じた扱い）

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
      // uid は同じものを使う
      items: remote.items.map((it) => Object.assign({}, it, { tags: it.tags.slice(), baseTitle: it.title })),
      preamble: remote.preamble,
      baseSha: remote.sha,
      baseText: remote.text,
      pending: null,
    };
    return draft;
  }

  function persistDraft() {
    if (!draft) { write(KEY_DRAFT, null); return; }
    const ok = write(KEY_DRAFT, {
      items: draft.items.map(stripUid), preamble: draft.preamble,
      baseSha: draft.baseSha, baseText: draft.baseText, pending: draft.pending,
    });
    if (!ok) toast('下書きを端末に保存できません（このまま閉じると変更は消えます）', true);
  }
  function restoreDraft() {
    const d = readJson(KEY_DRAFT);
    if (!d || !Array.isArray(d.items)) return;
    // 前の版の「食い違い」の状態（conflict）では、baseText がすでに最新に置き換わっていて元の版が分からない。
    // その時は base を空として扱い、最新にある件を消さないようにする
    const oldConflict = Array.isArray(d.conflict);
    draft = {
      items: d.items.map((it) => {
        const o = withUid(Object.assign({ tags: [] }, it));
        if (oldConflict) delete o.baseTitle;
        return o;
      }),
      preamble: String(d.preamble || ''),
      baseSha: d.baseSha || null,
      baseText: !oldConflict && typeof d.baseText === 'string' ? d.baseText : null,
      pending: d.pending && typeof d.pending.text === 'string' ? { text: d.pending.text, sha: d.pending.sha || null } : null,
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
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, isError ? 5000 : text.length > 30 ? 4000 : 1800);
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

  // ---- カテゴリ（説明文の塊で定義。1段目でカテゴリ、2段目でタグを選ぶ） ----
  const CAT_ALL = '*all';
  const CAT_OTHER = '*other';
  const normTag = (t) => t.normalize('NFKC').toLowerCase();

  function currentPreamble() {
    if (draft && !viewLatest) return draft.preamble;
    return remote.preamble;
  }

  // 表示するカテゴリ。定義にあってデータに無いタグは出さず、タグが1つも無いカテゴリも出さない
  function categoryGroups() {
    const counts = countTags(currentItems());
    const byKey = new Map(counts.map((x) => [normTag(x.tag), x]));
    const defs = parseCategories(currentPreamble());
    const defined = new Set();
    const groups = [];
    for (const c of defs) {
      const tags = [];
      for (const t of c.tags) {
        defined.add(normTag(t));
        const x = byKey.get(normTag(t));
        if (x && !tags.includes(x)) tags.push(x);
      }
      if (tags.length) groups.push({ key: 'cat:' + c.name, name: c.name, tags: tags });
    }
    const other = counts.filter((x) => !defined.has(normTag(x.tag)));
    const all = [{ key: CAT_ALL, name: 'すべて', tags: counts }];
    if (defs.length && other.length) groups.push({ key: CAT_OTHER, name: 'その他', tags: other });
    return { hasDefs: defs.length > 0, groups: defs.length ? all.concat(groups) : all };
  }

  function setOpenCategory(key) {
    openCategory = key;
    write(KEY_CAT_OPEN, key === null ? null : JSON.stringify(key));
    render();
  }

  function smallButton(text, label, onClick, className) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tag ' + (className || '');
    b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTagStrip() {
    const g = categoryGroups();
    const counts = g.groups[0].tags;
    els.tagStrip.hidden = counts.length === 0;
    if (counts.length === 0) { els.tagStrip.replaceChildren(); return; }
    const editCats = () => openCategories();
    // 塊が無ければ、カテゴリは「すべて」だけ。これまでどおりタグを全部並べる
    if (!g.hasDefs) {
      const row = document.createElement('div');
      row.className = 'tag-row';
      row.append(...counts.map((x) => tagButton(x.tag, { count: x.count })));
      row.append(smallButton('＋ カテゴリ', 'カテゴリを作る', editCats, 'cat-edit'));
      els.tagStrip.replaceChildren(row);
      return;
    }
    const active = activeTags().map(normTag);
    const open = g.groups.find((x) => x.key === openCategory) || null;
    const catRow = document.createElement('div');
    catRow.className = 'cat-row';
    catRow.setAttribute('role', 'group');
    catRow.setAttribute('aria-label', 'カテゴリ');
    for (const grp of g.groups) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat';
      const isOpen = open === grp;
      b.setAttribute('aria-expanded', String(isOpen));
      const chosen = grp.tags.filter((x) => active.includes(normTag(x.tag))).length;
      if (chosen) b.classList.add('has-active');
      const name = document.createElement('span');
      name.textContent = grp.name;
      const n = document.createElement('span');
      n.className = 'count';
      n.textContent = chosen ? chosen + '/' + grp.tags.length : String(grp.tags.length);
      b.append(name, n);
      b.setAttribute('aria-label', grp.name + '（タグ ' + grp.tags.length + ' 個' + (chosen ? '、' + chosen + ' 個を選択中' : '') + '）' + (isOpen ? 'を閉じる' : 'のタグを出す'));
      b.addEventListener('click', () => setOpenCategory(isOpen ? null : grp.key));
      catRow.append(b);
    }
    catRow.append(smallButton('編集', 'カテゴリを編集', editCats, 'cat-edit'));
    const parts = [catRow];
    if (open) {
      const row = document.createElement('div');
      row.className = 'tag-row';
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', open.name + ' のタグ');
      row.append(...open.tags.map((x) => tagButton(x.tag, { count: x.count })));
      parts.push(row);
    }
    els.tagStrip.replaceChildren(...parts);
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
    els.draftBar.classList.toggle('conflict', !!draft.pending);
    if (viewLatest) els.draftText.textContent = '最新の内容を表示中（手元の変更は残っています）';
    else if (draft.pending) els.draftText.textContent = '最新と食い違う件があります。下で選んでから保存してください';
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
      if (!draft || !draft.pending) hideNotice();
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
  // 最後に読んだ sha を付けて PUT する。ほかの場所で先に更新されていたら（409・sha の 422）、
  // 最新を読み直して3者の比較で合わせ、当たる件が無ければそのまま保存し直す。当たる件があれば選んでもらう。
  async function saveDraftNow(choices) {
    if (!draft || saving) return;
    if (editing && formChanged()) {
      const go = await ask('編集中の内容はまだ一覧に反映していません（OK を押していません）。反映せずに保存しますか？', '反映せずに保存');
      if (!go) return;
    }
    if (editing) closeEditor();
    const s = getSettings();
    saving = true;
    els.saveDraft.disabled = true;
    els.saveDraft.textContent = '保存中…';
    let mergedChanges = [];
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (draft.pending) {
          const m = applyMerge(choices);
          choices = null; // 選んだ内容は、この1回の合わせにだけ使う
          if (m.needsChoice) {
            showMergeChoices(m.result);
            toast('手元と最新の両方で変わった件があります。どちらを使うか選んでください', true);
            return;
          }
          if (!m.ok) return;
          mergedChanges = mergedChanges.concat(m.remoteChanges);
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
        if (draft.baseText != null && text === draft.baseText) {
          // 合わせた結果が最新と同じ（手元の変更がすべて最新に含まれていた）。空のコミットを作らない
          setRemote(text, draft.baseSha);
          dropDraft();
          hideNotice();
          render();
          toast('最新と同じ内容になったので、書き込みはしませんでした');
          return;
        }
        try {
          const r = await backendFor(s).write(text, draft.baseSha);
          setRemote(text, r.sha);
          dropDraft();
          hideNotice();
          render();
          remember(text, r.sha, s);
          toast(mergedChanges.length
            ? 'ほかの端末の変更（' + mergedChanges.join('、') + '）と合わせて保存しました'
            : '保存しました（' + remote.items.length + ' 件）');
          return;
        } catch (err) {
          if (err.kind !== 'conflict') throw err;
          // 最新を読み直して、次の周で合わせる
          const latest = await backendFor(s).read();
          setRemote(latest.text, latest.sha);
          remember(latest.text, latest.sha, s);
          draft.pending = { text: latest.text, sha: latest.sha };
          persistDraft();
        }
      }
      toast('保存の途中で何度も更新されました。少し待ってから、もう一度「保存」を押してください', true);
    } catch (err) {
      if (err instanceof TypeError) {
        toast('オフラインか接続できません。変更は端末に残っています', true);
      } else {
        showNotice(err.message + '\n変更は端末に残っています。', !!err.needsSettings);
        toast(err.message, true);
      }
    } finally {
      saving = false;
      els.saveDraft.disabled = false;
      els.saveDraft.textContent = '保存';
      renderDraftBar();
    }
  }

  function mergeInput(choices) {
    const p = draft.pending;
    return {
      base: draft.baseText != null ? parseSnippets(draft.baseText) : [],
      local: draft.items,
      remote: parseSnippets(p.text),
      basePreamble: draft.baseText != null ? extractPreamble(draft.baseText) : '',
      localPreamble: draft.preamble,
      remotePreamble: extractPreamble(p.text),
      choices: choices ? choices.items : null,
      preambleChoice: choices ? choices.preamble : null,
    };
  }

  // 下書きを最新（pending）に合わせ直す。当たる件が残れば何も変えずに知らせる
  function applyMerge(choices) {
    const result = mergeSnippets(mergeInput(choices));
    if (result.conflicts.length || result.preambleConflict) return { needsChoice: true, result: result };
    const p = draft.pending;
    draft.items = result.items.map((it) => withUid(it));
    draft.preamble = result.preamble;
    draft.baseText = p.text;
    draft.baseSha = p.sha;
    draft.pending = null;
    viewLatest = false;
    persistDraft();
    hideNotice();
    render();
    const errors = validateSnippets(draft.items);
    if (errors.length) {
      showNotice('ほかの端末の変更と合わせました。ただ、次の件はこのままでは保存できないので、直してから「保存」を押してください。\n' +
        errors.map((e) => '・' + ((draft.items[e.index] && draft.items[e.index].title) || '（タイトルなし）') + '：' + e.message).join('\n'), false);
      return { ok: false };
    }
    return { ok: true, remoteChanges: result.remoteChanges };
  }

  const KIND_TEXT = {
    'both-modified': '手元と最新の両方で変更',
    'local-modified-remote-deleted': '手元で変更、最新では削除',
    'local-deleted-remote-modified': '手元で削除、最新では変更',
    'both-added': '手元と最新の両方で同じタイトルの件を追加',
  };

  function summarize(it) {
    if (!it) return '削除する';
    const parts = [];
    if (it.tags && it.tags.length) parts.push(it.tags.map((t) => '#' + t).join(' '));
    const body = String(it.body || '').split('\n').filter((l) => l.trim()).slice(0, 2).join(' / ');
    parts.push(body.length > 80 ? body.slice(0, 80) + '…' : body || '（本文なし）');
    return parts.join('　');
  }

  // 当たる件ごとに「手元」「最新」を選んでもらう。選び終えたら合わせて保存する
  function showMergeChoices(result) {
    if (!draft || !draft.pending) return;
    const res = result || mergeSnippets(mergeInput(null));
    // 当たる件が無ければ、次に「保存」を押した時に自動で合わせる
    if (!res.conflicts.length && !res.preambleConflict) return;
    els.notice.replaceChildren();
    const form = document.createElement('form');
    form.className = 'merge';
    const intro = document.createElement('p');
    intro.textContent = 'data/snippets.md が、ほかの場所（Windows の同期や別の端末）で先に更新されていました。ほかの変更は自動で合わせます。次の件は手元と最新の両方で変わっているので、どちらを使うか選んでください。';
    form.append(intro);
    if (res.remoteChanges.length) {
      const p = document.createElement('p');
      p.className = 'merge-changes';
      p.textContent = '最新で変わった件：' + res.remoteChanges.join('、');
      form.append(p);
    }
    const rows = res.conflicts.map((c) => ({
      name: 'item:' + c.key, kind: KIND_TEXT[c.kind],
      title: c.local && c.remote && c.local.title !== c.remote.title ? c.remote.title + ' → ' + c.local.title : c.title,
      local: (c.local && c.local.title !== c.title ? c.local.title + '　' : '') + summarize(c.local),
      remote: summarize(c.remote),
    }));
    if (res.preambleConflict) {
      // カテゴリの違いなら、カテゴリの中身を並べる。そうでなければ説明文の先頭を出す
      const lc = parseCategories(res.preambleConflict.local);
      const rc = parseCategories(res.preambleConflict.remote);
      const catText = (cs) => cs.length ? cs.map((c) => c.name + '：' + c.tags.join(', ')).join('\n') : '（カテゴリなし）';
      const byCats = JSON.stringify(lc) !== JSON.stringify(rc);
      rows.push({ name: 'preamble', title: byCats ? 'カテゴリ' : '説明文（最初の ## より前）', kind: '手元と最新の両方で変更',
        local: byCats ? catText(lc) : res.preambleConflict.local.slice(0, 80),
        remote: byCats ? catText(rc) : res.preambleConflict.remote.slice(0, 80) });
    }
    for (const row of rows) {
      const fs = document.createElement('fieldset');
      fs.className = 'merge-item';
      const lg = document.createElement('legend');
      lg.textContent = row.title + '（' + row.kind + '）';
      fs.append(lg);
      for (const side of ['local', 'remote']) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'radio'; input.name = row.name; input.value = side;
        const head = document.createElement('b');
        head.textContent = side === 'local' ? '手元' : '最新';
        const text = document.createElement('span');
        text.textContent = row[side];
        label.append(input, head, text);
        fs.append(label);
      }
      form.append(fs);
    }
    const actions = document.createElement('div');
    actions.className = 'notice-actions';
    const save = document.createElement('button');
    save.type = 'submit'; save.className = 'btn small primary'; save.textContent = '選んだ内容で合わせて保存';
    save.disabled = true;
    const latest = document.createElement('button');
    latest.type = 'button'; latest.className = 'btn small ghost'; latest.textContent = '最新を見る';
    latest.addEventListener('click', () => { viewLatest = true; if (editing) closeEditor(); render(); });
    actions.append(save, latest);
    form.append(actions);
    const hint = document.createElement('p');
    hint.className = 'merge-hint';
    hint.textContent = '手元の変更をすべてやめるなら、上の「破棄」を押してください。';
    form.append(hint);
    const checked = (name) => form.querySelector('input[name="' + CSS.escape(name) + '"]:checked');
    const allChosen = () => rows.every((row) => checked(row.name));
    form.addEventListener('change', () => { save.disabled = !allChosen(); });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!allChosen()) return;
      const choices = { items: {}, preamble: null };
      for (const c of res.conflicts) choices.items[c.key] = checked('item:' + c.key).value;
      if (res.preambleConflict) choices.preamble = checked('preamble').value;
      saveDraftNow(choices);
    });
    els.notice.append(form);
    els.notice.hidden = false;
    renderDraftBar();
  }

  els.saveDraft.addEventListener('click', () => saveDraftNow());
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
      const it = withUid(Object.assign(v, { baseTitle: null }));
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

  // ---- カテゴリの編集 ----
  const catEls = {
    dialog: $('categories'), form: $('categories-form'), list: $('cat-list'),
    add: $('cat-add'), error: $('cat-error'), cancel: $('cat-cancel'), open: $('open-categories'),
  };
  let catWork = []; // 編集中のカテゴリ [{ name, tags }]

  // チェックの候補：データにあるタグ（件数の多い順）と、定義にだけあるタグ
  function categoryTagChoices() {
    const list = countTags(currentItems()).map((x) => ({ tag: x.tag, count: x.count, missing: false }));
    for (const c of catWork) {
      for (const t of c.tags) {
        if (!list.some((x) => normTag(x.tag) === normTag(t))) list.push({ tag: t, count: 0, missing: true });
      }
    }
    return list;
  }

  function renderCategoryEditor() {
    const choices = categoryTagChoices();
    catEls.list.replaceChildren(...catWork.map((c, i) => {
      const card = document.createElement('fieldset');
      card.className = 'cat-card';
      const head = document.createElement('div');
      head.className = 'cat-head';
      const name = document.createElement('input');
      name.value = c.name;
      name.placeholder = 'カテゴリの名前';
      name.setAttribute('aria-label', (i + 1) + ' 番目のカテゴリの名前');
      name.autocomplete = 'off';
      name.addEventListener('input', () => { c.name = name.value; validateCategories(); });
      const btn = (svgPath, label, onClick, disabled) => {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'icon-btn small'; b.setAttribute('aria-label', label); b.title = label;
        b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="' + svgPath + '"/></svg>';
        b.disabled = !!disabled;
        b.addEventListener('click', onClick);
        return b;
      };
      head.append(
        name,
        btn('M12 19V5M6 11l6-6 6 6', '上へ', () => { catWork.splice(i - 1, 0, catWork.splice(i, 1)[0]); renderCategoryEditor(); }, i === 0),
        btn('M12 5v14M6 13l6 6 6-6', '下へ', () => { catWork.splice(i + 1, 0, catWork.splice(i, 1)[0]); renderCategoryEditor(); }, i === catWork.length - 1),
        btn('M6 6l12 12M18 6L6 18', '「' + (c.name || '名前なし') + '」を削除', () => { catWork.splice(i, 1); renderCategoryEditor(); })
      );
      const tags = document.createElement('div');
      tags.className = 'cat-tags';
      for (const ch of choices) {
        const label = document.createElement('label');
        label.className = 'cat-tag' + (ch.missing ? ' missing' : '');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = c.tags.some((t) => normTag(t) === normTag(ch.tag));
        cb.addEventListener('change', () => {
          c.tags = cb.checked ? c.tags.concat([ch.tag]) : c.tags.filter((t) => normTag(t) !== normTag(ch.tag));
        });
        const text = document.createElement('span');
        text.textContent = '#' + ch.tag + (ch.missing ? '（データに無い）' : '');
        label.append(cb, text);
        tags.append(label);
      }
      if (!choices.length) {
        const p = document.createElement('p');
        p.className = 'hint';
        p.textContent = 'まだタグがありません。件にタグを付けると、ここで選べます。';
        tags.append(p);
      }
      card.append(head, tags);
      return card;
    }));
    validateCategories();
  }

  function validateCategories() {
    let msg = '';
    const seen = new Set();
    for (const c of catWork) {
      const err = categoryNameError(c.name);
      if (err) { msg = err + (c.name.trim() ? '（' + c.name.trim() + '）' : ''); break; }
      if (seen.has(c.name.trim())) { msg = '「' + c.name.trim() + '」が重複しています'; break; }
      seen.add(c.name.trim());
    }
    catEls.error.textContent = msg;
    catEls.error.hidden = !msg;
    return !msg;
  }

  function openCategories() {
    viewLatest = false;
    catWork = parseCategories(currentPreamble()).map((c) => ({ name: c.name, tags: c.tags.slice() }));
    if (els.dialog.open) els.dialog.close();
    renderCategoryEditor();
    catEls.dialog.showModal();
  }

  catEls.add.addEventListener('click', () => {
    catWork.push({ name: '', tags: [] });
    renderCategoryEditor();
    const inputs = catEls.list.querySelectorAll('.cat-head input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  catEls.cancel.addEventListener('click', () => catEls.dialog.close());
  catEls.open.addEventListener('click', openCategories);
  catEls.form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!validateCategories()) return;
    const cats = catWork.map((c) => ({ name: c.name.trim(), tags: c.tags }));
    let next;
    try { next = setCategories(currentPreamble(), cats); } catch (e) { catEls.error.textContent = e.message; catEls.error.hidden = false; return; }
    catEls.dialog.close();
    if (next === currentPreamble()) return;
    ensureDraft().preamble = next;
    persistDraft();
    render();
    toast('カテゴリを反映しました。「保存」で書き込みます');
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
  const savedCat = readJson(KEY_CAT_OPEN);
  if (typeof savedCat === 'string') openCategory = savedCat;
  const s0 = getSettings();
  if (!showCache('')) { render(); setStatus('読み込み中…'); }
  if (draft && draft.pending) showMergeChoices();
  if (!useDevLocal(s0) && !getToken() && !readJson(KEY_CACHE)) {
    setStatus('未設定');
    showNotice('はじめに設定で PAT を入力してください。', true);
  } else {
    load(); // 起動時に1回だけ
  }
})();
