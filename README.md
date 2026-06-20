# excalidraw-claude-code

**Excalidraw Canvas × Claude Code × VSCode** を別PCで手軽に再現するためのセットアップ。

Claude Code から Excalidraw のキャンバスへリアルタイムに図形を描き／読みできる
環境を、**clone も build も Node も不要**（キャンバスも MCP も Docker で動かす）で
立ち上げます。ホストに必要なのは **Docker だけ**。

**1 VSCode ウィンドウ = 1 テーマ**。テーマごとに独立したキャンバスを持ち、
好きなだけ並行できます（例: food 用、旅行用 …）。

## これで何ができる？

- ブラウザの Excalidraw（`http://127.0.0.1:<port>`）と Claude Code が双方向同期
- Claude が描いた図形がリアルタイムで画面に出る／あなたが描いた図形を Claude が読める
- 「図形で相談」しながら設計・議論できる
- **Figma風ピン留めチャット**: canvas を右クリックでスレッド作成、ドラッグでピン移動、
  右クリックメニューで削除、📋(右上)でピン一覧。複数ブラウザ間 WebSocket でリアルタイム同期。
- **オブジェクト紐付け**: 図形の上でピンを立てると、図形を動かしてもピンが追従。
- **ピン色で発言者がわかる**: 🔵 me / 🟣 claude code
- **テーマ名バッジ**: 画面下部に `🎨 <theme>` を固定表示。多窓並行時の見分け用。
- **永続化**: チャット履歴と canvas 描画(画像含む)をホスト側 `.chat-data/` に保存。
  Docker quit/restart はもちろん、ブラウザを閉じても次回復元できる。
- **Claude が "ここ" を理解する MCP**: ピンに「ここの色を赤く」と書くと Claude が
  ネイティブに読み取って既存の excalidraw MCP で図形を変更し、`claude code` 名義で
  チャット返信する（`list_chat_threads` / `get_chat_thread` / `post_chat_message`）。
- **Markdown チャット**: ` ```code``` ` / `**bold**` / `[link](url)` を整形表示。
- **テーマごとに色違いバッジ**: 多窓並行時に一目で判別。`./theme.sh list` には
  healthcheck の状態も出る。

## 前提（別PCに入れておくもの）

- [VSCode](https://code.visualstudio.com/) + **Claude Code 拡張**
- [Docker](https://www.docker.com/)（キャンバスと MCP の両方をコンテナで動かす）

> Node.js は不要です。

## クイックスタート

> 🌱 **初めての方は [TUTORIAL.md](TUTORIAL.md) に手順入りの 5 分ガイドがあります。**

```bash
git clone https://github.com/emmett-lathrop-brown/excalidraw-claude-code.git
cd excalidraw-claude-code
./theme.sh start food
```

表示される手順:

1. ワークスペースを**新しい VSCode ウィンドウ**で開く（`code ~/excalidraw-themes/food`）
2. ブラウザでキャンバス（`http://127.0.0.1:<port>`）を開く
3. そのウィンドウの Claude Code で `/mcp` を実行し、プロジェクトの `excalidraw` を**承認**（初回のみ）

## コマンド

| コマンド | 説明 |
|----------|------|
| `./theme.sh start [name]` | テーマを起動（キャンバス + ワークスペース `.mcp.json`）。`name` 省略時は `main` |
| `./theme.sh stop [name]`  | テーマのキャンバスを停止・削除。`name` 省略時は `main` |
| `./theme.sh list`         | テーマ一覧と URL を表示 |
| `./theme.sh help`         | ヘルプ |

オプション: `--port N`（ポート指定／省略時は空きを自動選択）、`--dir PATH`
（ワークスペースを既存フォルダにする。例: 実際のリポにテーマを紐付ける）。

```bash
./theme.sh start food       # food 用（自動で空きポート）
./theme.sh start travel      # 旅行用（別ポート）
./theme.sh list
./theme.sh stop travel
```

## 複数テーマを並行で（1 VSCode = 1 テーマ）

各テーマを別々の VSCode ウィンドウで開けば、会話もキャンバスも独立します。

仕組み:

- 各テーマ＝専用コンテナ `excalidraw-<name>`（独自ポート、`restart: unless-stopped`）
- ワークスペース直下の `.mcp.json`（**project スコープ**）が、その MCP を当該ポートのキャンバスへ向ける
- project スコープは global `~/.claude.json` を上書きするので、ウィンドウごとに別キャンバスへ接続される
- 既存プロジェクト（例: food リポ）をテーマにするなら `--dir <path>` でそこに `.mcp.json` を置ける
  （※ そのリポに `.mcp.json` が追加される点に注意。不要なら `.gitignore` 推奨）

## 後片付け

```bash
./theme.sh stop food                 # テーマのキャンバスを停止・削除
rm -rf ~/excalidraw-themes/food      # ワークスペースも消すなら
```

## 構成メモ

| 部品 | 何 | 入手 | ホスト依存 |
|------|----|------|-----------|
| キャンバスサーバー | Excalidraw UI + REST/WebSocket | Docker `ghcr.io/yctimlin/mcp_excalidraw-canvas` | Docker のみ |
| チャットサイドカー | Node の HTTP プロキシ。canvas HTML に `chat.js` を inject し、`/__chat/*` で REST/WebSocket を提供 | このリポジトリの `chat/` を `docker build` で内製 | Docker のみ |
| MCP サーバー | Claude Code ↔ キャンバスの橋渡し（stdio） | Docker `ghcr.io/yctimlin/mcp_excalidraw` | Docker のみ |

ベースは [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)。
すべて Docker で動かすので、ホストに Node を入れずに済み、キャンバスは
VSCode 拡張のリロードでも落ちません。上流の canvas イメージは fork していません。

### チャット機能の構造

```
ブラウザ → http://127.0.0.1:<port> → chat sidecar (Node)
                                      ├─ /          → canvas container にプロキシ
                                      │                (HTML に <script defer> を挿入)
                                      ├─ /__chat/chat.js → ピン/パネル/同期 UI
                                      ├─ /__chat/api/*   → REST (threads, messages)
                                      └─ /__chat/ws      → WebSocket (リアルタイム)

データ永続化（ホスト側 ~/excalidraw-themes/<theme>/.chat-data/）:
  ├─ chat.json              ← ピン・スレッド・メッセージ
  └─ canvas-snapshot.json   ← 30 秒毎の canvas 全要素 + 画像バイナリ
```

- canvas コンテナは docker network 内部のみ（公開ポートなし）
- chat sidecar が公開ポートを持ち、振り分ける
- ピン座標は scene 座標で記憶 → pan/zoom してもキャンバス上の同じ位置に追従
- 起動時、canvas が空なら snapshot から復元（files → elements の順で push）
