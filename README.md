# snipkey web（Android 用 PWA）

`data/snippets.md` を GitHub Contents API で読み、検索してタップでコピーする。ビルド工程も依存も無い静的ファイルだけでできている。仕様は [../SPEC.md](../SPEC.md)。

| ファイル | 役割 |
|---|---|
| `index.html` `styles.css` `app.js` | 画面 |
| `parser.js` | `snippets.md` のパーサ（ブラウザと Node の両方で読める） |
| `lib.js` | GitHub への要求の組み立てと検索（同上） |
| `sw.js` | 画面のファイルをキャッシュする Service Worker（データはキャッシュしない） |
| `manifest.webmanifest` `icons/` | ホーム画面に置くための情報 |
| `test/` | `node:test` の試験 |
| `tools/dev-server.js` | 開発用の静的サーバ |
| `tools/make-icons.js` | `icons/*.png` を作り直す |

## 試験

```
node --test web/test/*.test.js
```

## 手元で動かす

```
node web/tools/dev-server.js
```

`http://localhost:8787/web/` を開く。設定の「開発用：サーバ上のローカルファイル」を入れると、PAT なしで `../data/snippets.md` を読む。この項目は localhost・127.0.0.1 で開いた時だけ表示され、公開した URL では出ない。

## 動き

- 読み込むのは、起動時の1回と「更新」ボタンを押した時だけ。定期的には取りに行かない。
- 最後に読めた本文は localStorage（`snipkey.cache`）に保存し、オフラインや取得に失敗した時はそれを表示する。
- PAT は localStorage（`snipkey.token`）にだけ保存する。設定画面では値を表示しない。
- `run` の件は「▶ run」の印を付ける。タップしても本文をコピーするだけで、実行はしない。
- 検索欄で Enter を押すと、先頭の1件をコピーする。

## 画面のファイルを変えたら

`sw.js` の `VERSION` を上げる（古いキャッシュを消すため）。Service Worker はネットワーク優先なので、つながっていれば変更はすぐ反映される。
