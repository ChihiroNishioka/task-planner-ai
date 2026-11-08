# Task Planner AI

個人向けタスク管理Webアプリです。現在の実装は認証情報なしで動くモックMVPです。Notion、Google Drive、Gmail、Google Calendar、音声認識、AI、通知は実サービスへ接続しません。

## 起動

Node.js 24 と npm を用意し、次を実行します。

```sh
npm ci
npm run dev
```

ブラウザーで `http://localhost:3000` を開きます。秘密値は `.env.local` に置き、ソースやログへ書かないでください。別ターミナルでworkerを動かす場合は `timeout 1h npm run worker` を実行します。

## 実AI（サブスクCLI）でタスク分解とドラフトを作る

既定はモックです。`AI_MODE=cli` を **Web とワーカーの両方** に設定すると、ワーカーがローカルにログイン済みの `claude`（既定）または `codex` を呼び、タスク分解とドラフトを作ります。APIキーは使いません。

| 環境変数 | 既定 | 説明 |
| --- | --- | --- |
| `AI_MODE` | 未設定（モック） | `cli` で実AIを使う |
| `AI_CLI` | `claude` | `claude` または `codex` |
| `AI_CLI_MODEL` | `sonnet`（claude） | モデル名。codex は未指定ならCLIの既定 |
| `AI_CLI_PATH` | `claude` / `codex` | 実行ファイルのパス |
| `AI_TIMEOUT_MS` | `120000` | タイムアウト（ミリ秒） |

```sh
AI_MODE=cli timeout 8h npm run start -- --port 3310
AI_MODE=cli AI_CLI=claude timeout 8h npm run worker
```

CLIが見つからない・エラー終了・タイムアウト・出力不正のときはモックに戻し、画面に「モック（AI失敗: 理由）」と表示します。ワーカーが動いていないと「AIが作成中…」のままになります。修正指示による改訂は今回もモックです。

## テストと確認

```sh
npm test
npm run test:e2e
npm run lint
npm run typecheck
npm run secret-scan
```

`npm test` は単体/APIテストを実行します。`npm run test:e2e` はローカルNext.jsサーバーとChromiumを使い、iPhone 390x844とPC 1280x800の画面を確認します。Playwrightの画面テストはCIではなくローカルで実行します。

## Phase 6 の画面

画面テストは一覧、詳細、ドラフト比較、読み込み中、エラー、空状態を両方の表示幅で確認します。画像は [docs/screenshots](docs/screenshots/) にあります。

- iPhone: `iphone-390x844-list.png`、`iphone-390x844-detail.png`、`iphone-390x844-draft-comparison.png`、`iphone-390x844-loading.png`、`iphone-390x844-error.png`、`iphone-390x844-empty.png`
- PC: `pc-1280x800-list.png`、`pc-1280x800-detail.png`、`pc-1280x800-draft-comparison.png`、`pc-1280x800-loading.png`、`pc-1280x800-error.png`、`pc-1280x800-empty.png`

## 機能と制約

Phase 1から5では、SQLiteのタスク管理、添付ファイルのローカル保存、永続ジョブによる作業計画とMarkdown成果物、期限に応じた予定とアプリ内モック通知、成果物の版管理・評価・承認を実装しています。Phase 6ではCI、秘密・個人情報スキャン、Playwrightの画面確認を追加しました。

外部サービス、AI生成、音声文字起こし、画像/PDF解析、Calendar参照はモックまたは未実装です。画面とAPIでモックを示し、実サービスの接続成功とは扱いません。メール送信や外部への確定操作は実装していません。API認証、実サービス同期、品質メモリの自動適用も未実装です。

保存先にはSQLiteとローカルファイルを使います。PostgreSQLへの移行、バックアップと復元、本番向け認証・アクセス制御は未実装です。Docker構成はありますが、Dockerでのビルドと起動はこのPhaseで確認していません。依存パッケージの監査で報告された脆弱性の更新も未実施です。

## 開発段階

Phase 0は設計と環境、Phase 1はタスク管理、Phase 2は入力、Phase 3は準備とドラフト、Phase 4は期限と通知、Phase 5はレビューと再利用、Phase 6は統合検証を扱います。実装と検証の記録は `/workspace/dev/task-planner-ai/.runs/` にあります。
