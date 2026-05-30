# excalidraw-claude-code-setup

**Excalidraw Canvas × Claude Code × VSCode** を別PCで手軽に再現するためのセットアップ。

Claude Code から Excalidraw のキャンバスへリアルタイムに図形を描き／読みできる
環境を、**clone も build も不要**（Docker でキャンバス常駐 + `npx` で MCP）で立ち上げます。

## これで何ができる？

- ブラウザの Excalidraw（`http://127.0.0.1:3000`）と Claude Code が双方向同期
- Claude が描いた図形がリアルタイムで画面に出る／あなたが描いた図形を Claude が読める
- 「図形で相談」しながら設計・議論できる

## 前提（別PCに入れておくもの）

- [VSCode](https://code.visualstudio.com/) + **Claude Code 拡張**
- [Docker](https://www.docker.com/)（キャンバス常駐用。`--restart` で再起動・リロードでも生存）
- [Node.js](https://nodejs.org/)（MCP を `npx` で起動するため）

## クイックスタート

```bash
git clone https://github.com/akira-toriyama/excalidraw-claude-code-setup.git
cd excalidraw-claude-code-setup
./setup.sh
```

`setup.sh` がやること:

1. Docker でキャンバスサーバーを `:3000` に常駐起動（`docker compose up -d`）
2. `~/.claude.json` の `mcpServers` に `excalidraw`（`npx -y mcp-excalidraw-server`）を追記
3. 次の手順を表示

最後に:

- ブラウザで <http://127.0.0.1:3000> を開く
- Claude Code をリロード（VSCode: **Reload Window**）して `excalidraw` MCP を読み込む

## 手動でやる場合

```bash
# ① キャンバス常駐（リロード・再起動でも落ちない）
docker run -d -p 3000:3000 --restart unless-stopped \
  --name excalidraw-canvas ghcr.io/yctimlin/mcp_excalidraw-canvas:latest
```

`~/.claude.json` の `mcpServers` に追記:

```json
"excalidraw": {
  "command": "npx",
  "args": ["-y", "mcp-excalidraw-server@1.0.7"],
  "env": { "EXPRESS_SERVER_URL": "http://127.0.0.1:3000", "ENABLE_CANVAS_SYNC": "true" }
}
```

## 停止 / 後片付け

```bash
docker compose down          # キャンバス停止（このリポのディレクトリで）
# or:  docker rm -f excalidraw-canvas
```

MCP 登録を外すには `~/.claude.json` の `mcpServers.excalidraw` を削除。

## 構成メモ

| 部品 | 何 | 入手 |
|------|----|------|
| キャンバスサーバー | Excalidraw UI + REST/WebSocket（`:3000`） | Docker イメージ `ghcr.io/yctimlin/mcp_excalidraw-canvas` |
| MCP サーバー | Claude Code ↔ キャンバスの橋渡し（stdio） | npm `mcp-excalidraw-server`（`npx` 起動） |

ベースは [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)。
キャンバスは Docker で常駐させるので、VSCode 拡張のリロードでも落ちない
（手動 `node dist/server.js` 運用の弱点を解消）。
