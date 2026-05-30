# excalidraw-claude-code-setup

**Excalidraw Canvas × Claude Code × VSCode** を別PCで手軽に再現するためのセットアップ。

Claude Code から Excalidraw のキャンバスへリアルタイムに図形を描き／読みできる
環境を、**clone も build も Node も不要**（キャンバスも MCP も Docker で動かす）で立ち上げます。
ホストに必要なのは **Docker だけ**。

## これで何ができる？

- ブラウザの Excalidraw（`http://127.0.0.1:3000`）と Claude Code が双方向同期
- Claude が描いた図形がリアルタイムで画面に出る／あなたが描いた図形を Claude が読める
- 「図形で相談」しながら設計・議論できる

## 前提（別PCに入れておくもの）

- [VSCode](https://code.visualstudio.com/) + **Claude Code 拡張**
- [Docker](https://www.docker.com/)（キャンバスと MCP の両方をコンテナで動かす）

> Node.js は不要です。MCP サーバーは Docker コンテナとして起動し、
> `~/.claude.json` の編集も（ホストに node が無ければ）Docker 経由で行います。

## クイックスタート

```bash
git clone https://github.com/akira-toriyama/excalidraw-claude-code-setup.git
cd excalidraw-claude-code-setup
./setup.sh
```

`setup.sh` がやること:

1. Docker でキャンバスサーバーを `:3000` に常駐起動（`docker compose up -d`）
2. MCP イメージを事前 pull（初回の Claude 起動を速くする）
3. `~/.claude.json` の `mcpServers` に `excalidraw`（Docker 起動）を追記
4. 次の手順を表示

最後に:

- ブラウザで <http://127.0.0.1:3000> を開く
- Claude Code をリロード（VSCode: **Reload Window**）して `excalidraw` MCP を読み込む

## 手動でやる場合

```bash
# ① キャンバス常駐（リロード・再起動でも落ちない）
docker run -d -p 3000:3000 --restart unless-stopped \
  --name excalidraw-canvas ghcr.io/yctimlin/mcp_excalidraw-canvas:latest

# ② MCP イメージを pull（任意・初回を速く）
docker pull ghcr.io/yctimlin/mcp_excalidraw:latest
```

`~/.claude.json` の `mcpServers` に追記（MCP も Docker で起動）:

```json
"excalidraw": {
  "command": "docker",
  "args": [
    "run", "-i", "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-e", "EXPRESS_SERVER_URL=http://host.docker.internal:3000",
    "-e", "ENABLE_CANVAS_SYNC=true",
    "ghcr.io/yctimlin/mcp_excalidraw:latest"
  ]
}
```

Claude Code が MCP を起動するたびに使い捨てコンテナ（`--rm`）が立ち上がり、
`host.docker.internal:3000` 経由でキャンバスへ接続します。

## 停止 / 後片付け

```bash
docker compose down          # キャンバス停止（このリポのディレクトリで）
# or:  docker rm -f excalidraw-canvas
```

MCP 登録を外すには `~/.claude.json` の `mcpServers.excalidraw` を削除。

## 構成メモ

| 部品 | 何 | 入手 | ホスト依存 |
|------|----|------|-----------|
| キャンバスサーバー | Excalidraw UI + REST/WebSocket（`:3000`） | Docker `ghcr.io/yctimlin/mcp_excalidraw-canvas` | Docker のみ |
| MCP サーバー | Claude Code ↔ キャンバスの橋渡し（stdio） | Docker `ghcr.io/yctimlin/mcp_excalidraw` | Docker のみ |

ベースは [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)。
両方を Docker で動かすので、ホストに Node を入れずに済み、キャンバスは
VSCode 拡張のリロードでも落ちません（手動 `node` 運用の弱点を解消）。
