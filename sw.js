// snipkey Service Worker：画面のファイルだけをキャッシュして、オフラインでも開けるようにする。
// データ（GitHub API・ローカルの snippets.md）はここではキャッシュしない。最後に読めた内容は app.js が localStorage に持つ。
// 画面のファイルを変えたら VERSION を上げる。
const VERSION = 'snipkey-v1';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'parser.js',
  'lib.js',
  'app.js',
  'manifest.webmanifest',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'reload' })))).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('snipkey-') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  // 自分の画面のファイル以外（GitHub API、スコープ外のデータ）は素通しにする
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // ネットワーク優先：つながれば最新の画面を使って保存し直し、つながらなければ保存分を返す
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./') : Response.error()))
      )
  );
});
