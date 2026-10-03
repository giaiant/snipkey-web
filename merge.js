// snipkey: 保存が食い違った時に、3つの版を合わせる（画面に依存しない純粋な関数）。
// base：最後に読んだ版 / local：手元の下書き / remote：最新。件はタイトルを鍵にして対応させる。
// 手元の件は baseTitle（base でのタイトル。新しく足した件は null）を持ち、改名しても base との対応を保つ。
// ブラウザでは window.SnipkeyMerge、Node では require('./merge.js') で使う。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SnipkeyMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FIELDS = ['title', 'type', 'tags', 'shell', 'confirm', 'window', 'body'];

  function pick(it) {
    const o = {};
    for (const k of FIELDS) o[k] = k === 'tags' ? (it.tags || []).slice() : it[k];
    return o;
  }
  function same(a, b) {
    if (!a || !b) return a === b;
    return JSON.stringify(pick(a)) === JSON.stringify(pick(b));
  }

  // base の件と手元の件を対応させる。baseTitle が無い件（古い下書き）はタイトルで探す
  function matchLocal(base, local) {
    const baseTitles = new Set(base.map((b) => b.title));
    const used = new Set();
    return local.map((l) => {
      let t = l.baseTitle;
      if (t === undefined) t = baseTitles.has(l.title) ? l.title : null;
      if (t === null || !baseTitles.has(t) || used.has(t)) return null;
      used.add(t);
      return t;
    });
  }

  // 前の版から後の版で変わった件を「追加：…」「変更：…」「削除：…」で返す
  function describeChanges(before, after) {
    const a = new Map(before.map((it) => [it.title, it]));
    const b = new Map(after.map((it) => [it.title, it]));
    const out = [];
    for (const [t, it] of b) {
      if (!a.has(t)) out.push('追加：' + t);
      else if (!same(a.get(t), it)) out.push('変更：' + t);
    }
    for (const t of a.keys()) if (!b.has(t)) out.push('削除：' + t);
    return out;
  }

  // 3つの版を合わせる。
  // args: { base, local, remote, basePreamble, localPreamble, remotePreamble, choices, preambleChoice }
  //   choices：当たる件の key → 'local' | 'remote'。preambleChoice も同じ。
  // 返り値: { items, preamble, conflicts, preambleConflict, remoteChanges }
  //   items の各件は baseTitle（remote でのタイトル。手元で足した件は null）を持つ。
  //   conflicts は、まだ選ばれていない当たる件 [{ key, kind, title, local, remote }]。選ばれていない件は remote のままにする。
  function mergeSnippets(args) {
    const base = args.base || [];
    const local = args.local || [];
    const remote = args.remote || [];
    const choices = args.choices || {};
    const conflicts = [];

    const baseMap = new Map(base.map((b) => [b.title, b]));
    const remoteTitles = new Set(remote.map((r) => r.title));
    const matched = matchLocal(base, local);
    const localByBase = new Map();
    matched.forEach((t, i) => { if (t !== null) localByBase.set(t, local[i]); });

    // 結果は remote の並びを土台にする。entry: { id, item, baseTitle }
    const result = remote.map((r) => ({ id: 'r:' + r.title, item: pick(r), baseTitle: r.title }));
    const indexOfId = (id) => result.findIndex((e) => e.id === id);
    const removeId = (id) => { const i = indexOfId(id); if (i >= 0) result.splice(i, 1); };
    const replaceId = (id, item) => { const i = indexOfId(id); if (i >= 0) result[i].item = pick(item); };

    const keptLocal = new Set(); // 手元を選んだ件（最新の変更は取り込んでいない）
    function decide(c) {
      const choice = choices[c.key];
      if (choice === 'local') keptLocal.add(c.title);
      if (choice === 'local' || choice === 'remote') return choice;
      conflicts.push(c);
      return 'remote';
    }

    const toInsert = new Set(); // 手元の位置に合わせて差し込む件（local の添え字）

    // base にあった件：手元での変更・削除を remote に当てる
    for (const b of base) {
      const t = b.title;
      const l = localByBase.get(t) || null;
      const r = remoteTitles.has(t) ? remote.find((x) => x.title === t) : null;
      const localChanged = l ? !same(b, l) : true; // l が無い＝手元で削除
      if (!localChanged) continue; // 手元で触っていない件は remote のまま
      const remoteChanged = r ? !same(b, r) : true;
      if (l && r) {
        if (!remoteChanged || same(l, r)) { replaceId('r:' + t, l); continue; }
        if (decide({ key: t, kind: 'both-modified', title: t, local: pick(l), remote: pick(r) }) === 'local') replaceId('r:' + t, l);
      } else if (l && !r) {
        // 手元で変更、最新では削除
        if (decide({ key: t, kind: 'local-modified-remote-deleted', title: t, local: pick(l), remote: null }) === 'local') {
          toInsert.add(local.indexOf(l));
        }
      } else if (!l && r) {
        // 手元で削除
        if (!remoteChanged) { removeId('r:' + t); continue; }
        if (decide({ key: t, kind: 'local-deleted-remote-modified', title: t, local: null, remote: pick(r) }) === 'local') removeId('r:' + t);
      }
      // !l && !r：両方で削除。何もしない
    }

    // 手元で足した件
    local.forEach((l, i) => {
      if (matched[i] !== null) return;
      const clash = result.find((e) => e.item.title === l.title && !baseMap.has(l.title));
      if (clash) {
        // 両方で同じタイトルの件を足した
        if (same(clash.item, l)) return;
        if (decide({ key: 'added:' + l.title, kind: 'both-added', title: l.title, local: pick(l), remote: pick(clash.item) }) === 'local') {
          clash.item = pick(l);
        }
        return;
      }
      toInsert.add(i);
    });

    // 手元の並びで前にある件の後ろ（無ければ、後ろにある件の前）に差し込む
    const idOfLocal = (i) => {
      if (toInsert.has(i)) return 'l:' + i;
      const t = matched[i];
      return t !== null ? 'r:' + t : null;
    };
    local.forEach((l, i) => {
      if (!toInsert.has(i)) return;
      const entry = { id: 'l:' + i, item: pick(l), baseTitle: null };
      let at = -1;
      for (let j = i - 1; j >= 0 && at < 0; j--) {
        const id = idOfLocal(j);
        const k = id ? indexOfId(id) : -1;
        if (k >= 0) at = k + 1;
      }
      for (let j = i + 1; j < local.length && at < 0; j++) {
        const id = idOfLocal(j);
        if (id && id.startsWith('l:')) continue; // まだ差し込んでいない
        const k = id ? indexOfId(id) : -1;
        if (k >= 0) at = k;
      }
      if (at < 0) at = result.length;
      result.splice(at, 0, entry);
    });

    // 説明文
    const bp = args.basePreamble || '';
    const lp = args.localPreamble == null ? bp : args.localPreamble;
    const rp = args.remotePreamble == null ? bp : args.remotePreamble;
    let preamble = rp;
    let preambleConflict = null;
    if (lp !== bp && rp !== bp && lp !== rp) {
      const c = args.preambleChoice;
      if (c === 'local') preamble = lp;
      else if (c !== 'remote') preambleConflict = { local: lp, remote: rp };
    } else if (lp !== bp) {
      preamble = lp;
    }

    return {
      items: result.map((e) => Object.assign(e.item, { baseTitle: e.baseTitle })),
      preamble: preamble,
      conflicts: conflicts,
      preambleConflict: preambleConflict,
      // 取り込んだ最新の変更（手元を選んだ件は除く）
      remoteChanges: describeChanges(base, remote).filter((s) => !keptLocal.has(s.replace(/^[^：]+：/, ''))),
    };
  }

  return { mergeSnippets: mergeSnippets, describeChanges: describeChanges, sameSnippet: same };
});
