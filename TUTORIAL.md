# チュートリアル：5分で動かす

ピン留めチャット付きの Excalidraw キャンバスを Claude Code と一緒に使うまでの手順。
**Docker と VSCode が入っていれば 5 分で動きます**。Node.js は不要です。

---

## 1. 必要なもの

- **Docker Desktop**（起動しておく）— <https://www.docker.com/>
- **VSCode** + **Claude Code 拡張機能**

> macOS / Linux / Windows(WSL2) で動作確認。

---

## 2. クローンして起動

```bash
git clone https://github.com/akira-toriyama/excalidraw-claude-code.git
cd excalidraw-claude-code
./theme.sh start food
```

初回は chat サイドカー用の Docker イメージをローカルでビルドします（30 秒〜1 分）。

成功するとこんな出力になります：

```
▶ building chat sidecar image (excalidraw-chat:local)…
  built excalidraw-chat:local
▶ theme 'food' → port 51234
  created canvas excalidraw-food (internal)
  created chat sidecar excalidraw-chat-food on :51234
  wrote ~/excalidraw-themes/food/.mcp.json (project-scoped MCP → excalidraw + excalidraw-chat)
  canvas up: http://127.0.0.1:51234

code ~/excalidraw-themes/food
http://127.0.0.1:51234
```

ポート番号 (`51234`) は空きを自動で拾うので毎回違うことがあります。
末尾 2 行は **そのままコピペで使う** のが楽です。

---

## 3. 2 つを並べて開く

**(a) ワークスペース** — VSCode の新規ウィンドウで開く：

```bash
code ~/excalidraw-themes/food
```

**(b) キャンバス** — ブラウザで開く：

```
http://127.0.0.1:51234
```

ブラウザ画面の下に `🎨 food` というバッジが出ていれば起動成功です。
バッジ色はテーマ名から自動で決まるので、複数テーマを開いても色で見分けられます。

---

## 4. MCP を承認（初回だけ）

VSCode の Claude Code パネルで：

```
/mcp
```

`excalidraw` と `excalidraw-chat` の 2 つが表示されるので、**両方 Approve** します。

| MCP | 何ができる |
|-----|-----------|
| `excalidraw` | 図形の作成・編集・削除（Claude がキャンバスに描く） |
| `excalidraw-chat` | ピン留めチャットの読み書き（Claude が「ここ」を理解する） |

---

## 5. ブラウザで遊んでみる

1. ツールバーから「四角形」(`2` キー) を選んでドラッグ → 図形を描く
2. その図形の上で **右クリック** → 紫色のピンが立ち、右側にチャットパネルが開く
3. メッセージ欄に書いて送信：

   > `これの色を赤くして`

ピンの色は最後に書いた人で変わります（🔵 me / 🟣 claude code）。
ドラッグでピンの位置を動かせ、右クリックメニューから削除できます。

---

## 6. Claude に答えさせる

VSCode の Claude Code に頼みます：

> food テーマのピン全部見て、新しい質問あったら答えて

Claude が裏で：

1. `list_chat_threads` で立っているピンを列挙
2. `get_chat_thread` でそれぞれのメッセージを読む
3. （図形操作が必要なら）既存の `excalidraw` MCP の `update_element` などを呼ぶ
4. `post_chat_message` で `claude code` 名義で返信

数秒後、ブラウザでは：
- 図形の色が変わる
- ピンが紫色に光る（パネル閉じていても気付ける）
- チャットに紫バブルで返信が表示される（Markdown 効きます：`` `code` ``, **bold**, [link](url) も OK）

> 💡 Claude はポーリングしないので、**「ピン見て」と一言頼む** のが基本です。

---

## 7. テーマを増やす

別の話題用に独立したキャンバス＋ワークスペースが欲しくなったら：

```bash
./theme.sh start travel
```

別ポート・別ワークスペース・別チャット履歴で並行できます。

**1 VSCode ウィンドウ = 1 テーマ** が基本構成。Window A は food, Window B は travel …のように使い分け。

---

## 8. 一覧・再起動・停止

```bash
./theme.sh list           # 動いてるテーマ一覧 (STATUS / HEALTH / PINS / URL)
./theme.sh restart food   # 設定変えた後にサッと再起動
./theme.sh stop food      # 1 テーマだけ片付け
./theme.sh stop-all       # 全テーマ片付け
```

### データはどう残る？

- **チャット履歴**: ホスト側の `~/excalidraw-themes/<theme>/.chat-data/chat.json`
- **キャンバス描画 (画像含む)**: 同じく `.chat-data/canvas-snapshot.json` に 30 秒毎にスナップショット
- `./theme.sh stop` してもファイルは残ります。再度 `start` すれば snapshot から自動復元します
- Docker Desktop を quit / 起動しても、コンテナは `restart: unless-stopped` で自動復帰します

---

## トラブルシューティング

| 症状 | チェック |
|------|---------|
| `docker not found` | Docker Desktop が起動しているか |
| ブラウザでキャンバスが白い | `./theme.sh list` で `HEALTH=healthy` か確認。違えば `docker logs excalidraw-chat-<name>` |
| `/mcp` に何も出ない | VSCode のプロジェクトルートが `~/excalidraw-themes/<name>` か。ここに `.mcp.json` がある |
| ピンが反応しない | ブラウザで Cmd+Shift+R (ハードリロード) — `chat.js` がキャッシュされてる |
| 画像が復元されない | 添付した直後は数秒待つ（`chat.js` が `/api/files` に push してから snapshot 取得） |

### 完全リセット

```bash
./theme.sh stop-all
rm -rf ~/excalidraw-themes
docker image rm excalidraw-chat:local   # チャット sidecar の再ビルドが必要なときだけ
```

---

## もっと知る

- アーキテクチャの中身（Docker network、MCP の stdio プロトコル、Snapshot の挙動）は [README.md](README.md#構成メモ) を参照
- 上流の Excalidraw キャンバス画像は [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw) — fork せずに利用しています
