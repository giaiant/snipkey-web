'use strict';
// 開発用の静的サーバ（依存なし）。リポジトリの最上位を配り、画面は /web/ で開く。
// 実行: node web/tools/dev-server.js [port]   → http://localhost:8787/web/
// localhost で開くと、設定の「開発用：ローカルファイル」で ../data/snippets.md を読める。
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT = Number(process.argv[2]) || 8787;
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

http.createServer((req, res) => {
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
});
