# snipkey web（Android 用 PWA）

`data/snippets.md` を GitHub Contents API で読み、検索してタップでコピーする。同じ画面で追加・編集・削除・並べ替えをして、GitHub に保存できる。ビルド工程も依存も無い静的ファイルだけでできている。仕様は [../SPEC.md](../SPEC.md)。

| ファイル | 役割 |
|---|---|
| `index.html` `styles.css` `app.js` | 画面 |
| `parser.js` | `snippets.md` のパーサと書き出し（ブラウザと Node の両方で読める） |
| `lib.js` | GitHub への読み書きの要求の組み立てと検索（同上） |
| `sw.js` | 画面のファイルをキャッシュする Service Worker（データはキャッシュしない） |
| `manifest.webmanifest` `icons/` | ホーム画面に置くための情報 |
| `test/` | `node:test` の試験 |
| `tools/dev-server.js` | 開発用の静的サーバ（ローカルファイルの読み書き口つき） |
| `tools/make-icons.js` | `icons/*.png` を作り直す |

## 試験

```
node --test web/test/*.test.js
```

## 手元で動かす

```
node web/tools/dev-server.js
```

`http://localhost:8787/web/` を開く。設定の「開発用：開発サーバのローカルファイルを読み書きする」を入れると、PAT なしで開発サーバの `/dev-api/data` を通してデータを読む。この項目は localhost・127.0.0.1 で開いた時だけ表示され、公開した URL では出ない。開発用の時は GitHub には読み書きしない。

保存（編集）を試す時は、データの写しを作って `--data` で渡す。`--data` が無い時は `data/snippets.md` を読むだけで、保存は 403 で断る（試験で本物のデータを書き換えないため）。

```
node web/tools/dev-server.js 8787 --data C:\path	o\copy-of-snippets.md
```

`/dev-api/data` は GitHub の Contents API と同じ形で sha を返し、PUT の sha が今のファイルと合わなければ 409 を返す。写しを別のエディタで書き換えてから保存すると、食い違いの動きを試せる。

## 動き

- 読み込むのは、起動時の1回と「更新」ボタンを押した時だけ。定期的には取りに行かない。
- 最後に読めた本文は localStorage（`snipkey.cache`）に保存し、オフラインや取得に失敗した時はそれを表示する。
- PAT は localStorage（`snipkey.token`）にだけ保存する。設定画面では値を表示しない。見るだけなら Contents: Read-only、編集して保存するなら Contents: Read and write の fine-grained PAT にする（対象は snipkey のリポジトリだけ）。
- `run` の件は「▶ run」の印を付ける。タップしても本文をコピーするだけで、実行はしない。
- 検索欄で Enter を押すと、先頭の1件をコピーする。

## 画面のファイルを変えたら

`sw.js` の `VERSION` を上げる（古いキャッシュを消すため）。Service Worker はネットワーク優先なので、つながっていれば変更はすぐ反映される。

## 編集

- 一覧の各件の鉛筆で編集、下の ＋ で新規追加。PC の幅（900px 以上）では一覧と編集フォームを左右に並べ、スマホでは編集画面に切り替える（端末の「戻る」で一覧に戻る）。
- 項目はタイトル・type・tags・本文。type が run の時だけ shell・window・confirm を出す。
- 編集フォームの「OK」は手元の下書きに反映するだけ。上に出る「保存」で、まとめて GitHub に書き込む（コミットメッセージは `data: update snippets from web`）。下書きは localStorage（`snipkey.draft`）に置くので、閉じても消えない。「破棄」で最後に読んだ内容に戻す。
- 削除は確認ダイアログを出す。並べ替えは編集フォームの ↑↓ で行う。
- 保存できないもの：タイトルが空、ほかの件と同じタイトル（Windows 側の使用履歴がタイトルで紐付いているため）、本文に `~~~` だけの行がある件。
- 保存は最後に読んだ sha を付けて PUT する。ほかの場所で先に更新されていて 409（または sha についての 422）になった時は、最新を読み直し、手元の下書きはそのまま残して、変わった件のタイトルを知らせる。「最新を見る」で中身を確かめ、必要な変更を手元にも入れてから、もう一度「保存」を押す（手元の内容で上書きする）。
- 403 の時は、PAT に書き込み権限が無い（読み取り専用の PAT）と案内する。
- 書き出しの形式：説明文（最初の `## ` より前）はそのまま残す。type は常に書き、ほかのキーは既定値と同じなら省く。改行は LF。本文の囲みが無い件や、本文の後ろに書いた文章は、読む時と同じく捨てられる。
