# excalidraw-claude-code-setup

**Excalidraw Canvas × Claude Code × VSCode** を別PCで手軽に再現するためのセットアップ。

Claude Code から Excalidraw のキャンバスへリアルタイムに図形を描き／読みできる
環境を、**clone も build も Node も不要**（キャンバスも MCP も Docker で動かす）で
立ち上げます。ホストに必要なのは **Docker だけ**。

**1 VSCode ウィンドウ = 1 テーマ**。テーマごとに独立したキャンバスを持ち、
好きなだけ並行できます（例: facet 用、旅行用 …）。

## これで何ができる？

- ブラウザの Excalidraw（`http://127.0.0.1:<port>`）と Claude Code が双方向同期
- Claude が描いた図形がリアルタイムで画面に出る／あなたが描いた図形を Claude が読める
- 「図形で相談」しながら設計・議論できる

## 前提（別PCに入れておくもの）

- [VSCode](https://code.visualstudio.com/) + **Claude Code 拡張**
- [Docker](https://www.docker.com/)（キャンバスと MCP の両方をコンテナで動かす）

> Node.js は不要です。

## クイックスタート

```bash
git clone https://github.com/akira-toriyama/excalidraw-claude-code-setup.git
cd excalidraw-claude-code-setup
./setup.sh start facet
```

表示される手順:

1. ワークスペースを**新しい VSCode ウィンドウ**で開く（`code ~/excalidraw-themes/facet`）
2. ブラウザでキャンバス（`http://127.0.0.1:<port>`）を開く
3. そのウィンドウの Claude Code で `/mcp` を実行し、プロジェクトの `excalidraw` を**承認**（初回のみ）

## コマンド

| コマンド | 説明 |
|----------|------|
| `./setup.sh start [name]` | テーマを起動（キャンバス + ワークスペース `.mcp.json`）。`name` 省略時は `main` |
| `./setup.sh stop [name]`  | テーマのキャンバスを停止・削除。`name` 省略時は `main` |
| `./setup.sh list`         | テーマ一覧と URL を表示 |
| `./setup.sh help`         | ヘルプ |

オプション: `--port N`（ポート指定／省略時は空きを自動選択）、`--dir PATH`
（ワークスペースを既存フォルダにする。例: 実際のリポにテーマを紐付ける）。

```bash
./setup.sh start facet       # facet 用（自動で空きポート）
./setup.sh start travel      # 旅行用（別ポート）
./setup.sh list
./setup.sh stop travel
```

## 複数テーマを並行で（1 VSCode = 1 テーマ）

各テーマを別々の VSCode ウィンドウで開けば、会話もキャンバスも独立します。

仕組み:

- 各テーマ＝専用コンテナ `excalidraw-<name>`（独自ポート、`restart: unless-stopped`）
- ワークスペース直下の `.mcp.json`（**project スコープ**）が、その MCP を当該ポートのキャンバスへ向ける
- project スコープは global `~/.claude.json` を上書きするので、ウィンドウごとに別キャンバスへ接続される
- 既存プロジェクト（例: facet リポ）をテーマにするなら `--dir <path>` でそこに `.mcp.json` を置ける
  （※ そのリポに `.mcp.json` が追加される点に注意。不要なら `.gitignore` 推奨）

## 手動でやる場合

```bash
# キャンバス常駐（リロード・再起動でも落ちない）
docker run -d -p 3000:3000 --restart unless-stopped \
  --name excalidraw-main ghcr.io/yctimlin/mcp_excalidraw-canvas:latest
```

ワークスペース直下に `.mcp.json` を置く（MCP も Docker で起動）:

```json
{
  "mcpServers": {
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
  }
}
```

Claude Code が MCP を起動するたびに使い捨てコンテナ（`--rm`）が立ち上がり、
`host.docker.internal:<port>` 経由でキャンバスへ接続します。

## 後片付け

```bash
./setup.sh stop facet                 # テーマのキャンバスを停止・削除
rm -rf ~/excalidraw-themes/facet      # ワークスペースも消すなら
```

## 構成メモ

| 部品 | 何 | 入手 | ホスト依存 |
|------|----|------|-----------|
| キャンバスサーバー | Excalidraw UI + REST/WebSocket | Docker `ghcr.io/yctimlin/mcp_excalidraw-canvas` | Docker のみ |
| MCP サーバー | Claude Code ↔ キャンバスの橋渡し（stdio） | Docker `ghcr.io/yctimlin/mcp_excalidraw` | Docker のみ |

ベースは [yctimlin/mcp_excalidraw](https://github.com/yctimlin/mcp_excalidraw)。
両方を Docker で動かすので、ホストに Node を入れずに済み、キャンバスは
VSCode 拡張のリロードでも落ちません。
