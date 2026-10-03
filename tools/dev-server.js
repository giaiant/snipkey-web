'use strict';
// 開発用の静的サーバ（依存なし）。リポジトリの最上位を配り、画面は /web/ で開く。
// 実行: node web/tools/dev-server.js [port] [--data <file>]   → http://localhost:8787/web/
// localhost で開くと、設定の「開発用：ローカルファイル」で /dev-api/data を通してデータを読める。
// 読むのは --data のファイル（無ければ data/snippets.md）。保存（PUT）できるのは --data を付けた時だけで、
// data/snippets.md には書かない。試験の時は写しを作って --data で渡す。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const dataIdx = args.indexOf('--data');
const WRITABLE = dataIdx >= 0 ? path.resolve(args.splice(dataIdx, 2)[1] || '') : null;
const PORT = Number(args[0]) || 8787;
const DATA_FILE = WRITABLE || path.join(ROOT, 'data', 'snippets.md');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

// git の blob と同じ求め方の sha（GitHub の Contents API に合わせる）
function blobSha(buf) {
  return crypto.createHash('sha1').update('blob ' + buf.length + '\0').update(buf).digest('hex');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// GitHub の Contents API をまねた読み書き口（応答の形と 409 の返し方を合わせる）
function devApi(req, res) {
  if (req.method === 'GET') {
    fs.readFile(DATA_FILE, (e, buf) => {
      if (e) { sendJson(res, 404, { message: 'Not Found: ' + DATA_FILE }); return; }
      sendJson(res, 200, { sha: blobSha(buf), encoding: 'base64', content: buf.toString('base64'), writable: !!WRITABLE });
    });
    return;
  }
  if (req.method !== 'PUT') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  if (!WRITABLE) {
    sendJson(res, 403, { message: '開発サーバは --data <file> を付けて起動した時だけ保存できます（data/snippets.md には書きません）' });
    return;
  }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= 2 * 1024 * 1024) chunks.push(c); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { body = null; }
    if (size > 2 * 1024 * 1024 || !body || typeof body.content !== 'string') { sendJson(res, 422, { message: 'Invalid request' }); return; }
    if (!body.sha) { sendJson(res, 422, { message: '"sha" was not supplied.' }); return; }
    let current = Buffer.alloc(0);
    try { current = fs.readFileSync(DATA_FILE); } catch (_) { /* 無ければ空として扱う */ }
    const curSha = blobSha(current);
    if (body.sha !== curSha) { sendJson(res, 409, { message: 'data does not match ' + body.sha }); return; }
    const next = Buffer.from(body.content, 'base64');
    fs.writeFileSync(DATA_FILE, next);
    console.log('saved', DATA_FILE, '(' + next.length + ' bytes) message:', JSON.stringify(body.message));
    sendJson(res, 200, { content: { sha: blobSha(next) }, commit: { message: body.message } });
  });
}

http.createServer((req, res) => {
  if (req.url.split('?')[0] === '/dev-api/data') { devApi(req, res); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (_) { rel = '/'; }
  let file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403).end(); return; }
  // 配るのは web/ と data/ だけ
  const top = path.relative(ROOT, file).split(path.sep)[0];
  if (top !== 'web' && top !== 'data') { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) {
      if (!rel.endsWith('/')) { res.writeHead(301, { Location: rel + '/' }).end(); return; }
      file = path.join(file, 'index.html');
    }
    fs.readFile(file, (e, buf) => {
      if (e) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      res.end(buf);
    });
  });
}).listen(PORT, '127.0.0.1', () => {
  console.log('snipkey dev server: http://localhost:' + PORT + '/web/');
  console.log(WRITABLE ? 'data (writable): ' + WRITABLE : 'data (read only): ' + DATA_FILE);
});
