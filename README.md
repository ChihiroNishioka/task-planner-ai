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

既定はモックです。`AI_MODE=cli` を設定すると、ローカルにログイン済みの `claude`（既定）または `codex` を呼び、タスク分解とドラフト（ワーカー）と修正指示による改訂（Webサーバー）を作ります。APIキーは使いません。初版を作るのは**ワーカー**、改訂を作るのは**Webサーバー**のプロセスなので、実AIで両方を動かすなら両方に `AI_MODE=cli`（と同じ `AI_CLI*`）を設定します。

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

CLIが見つからない・エラー終了・タイムアウト・出力不正のときはモックに戻し、画面に「モック（AI失敗: 理由）」と表示します。ワーカーが動いていないと「AIが作成中…」のままになります。修正指示による改訂も同じ扱いで、失敗・タイムアウト時はモックの改訂版を保存し、版のラベルに「モック（AI失敗: 理由）」と出ます。

画面（一覧のバナー・設定ページ）のAI実行モードは、Webの環境変数ではなく**常駐ワーカーが `worker_status` テーブルに記録した実モード**を表示します。ワーカーは5秒ごとにheartbeatを書き、20秒以上更新が無いと「停止または応答なし」、一度も起動していなければ「未起動（実行モードは不明）」と表示します（`--once` 実行は記録しません）。

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

## Googleログイン

ログインには Firebase Authentication の Google プロバイダーを使います。次の環境変数を設定してください。

- `AUTH_MODE` は通常未設定のままにします。未設定時は Firebase 認証を使います。
- `ALLOWED_EMAILS` は利用を許可するメールアドレスをカンマ区切りで指定します。空の場合は全員拒否します。
- `SESSION_SECRET` は `openssl rand -base64 48` で生成します。32文字以上が必要です。
- `FIREBASE_API_KEY`、`FIREBASE_AUTH_DOMAIN`、`FIREBASE_PROJECT_ID` は Firebase コンソールの Web アプリ設定から読み込みます。

Firebase コンソールの Authentication 設定で Google プロバイダーを有効にし、公開ホスト名を承認済みドメインへ追加してください。設定値は実行時環境に置き、リポジトリへ登録しないでください。

`AUTH_MODE=test` はローカルのテスト専用です。テスト用メール入力欄を表示し、Google へ接続しません。本番環境ではこのモードを拒否します。

### box での起動（Tailscale Funnel 配下）

```sh
export DATABASE_PATH=/path/to/data/app.sqlite BLOB_DIRECTORY=/path/to/data/blobs ARTIFACT_DIRECTORY=/path/to/data/artifacts
export ALLOWED_EMAILS=... SESSION_SECRET=... FIREBASE_API_KEY=... FIREBASE_AUTH_DOMAIN=... FIREBASE_PROJECT_ID=...
timeout 10m npm run build
npm start -- --port 3310     # Web（127.0.0.1 で待ち受け。Funnel の / をこのポートへ向ける）
npm run worker               # ワーカー（認証の影響なし。DATABASE_PATH などは Web と同じ値）
```

- Firebase の Web 設定（3つ）は、同じ Firebase プロジェクトを使う駄洒落保管庫の Web 設定と同じ値です。ブラウザーに載る公開値ですが、リポジトリには書かず環境変数で渡します。
- 公開ホストは Firebase コンソール →（プロジェクト）→ Authentication → 設定 → 承認済みドメイン に追加しておきます。
- Web は `NODE_ENV=production`（`npm start`）で動かすので、Cookie には Secure が付きます。`AUTH_MODE=test` は本番では拒否されます。
- 環境変数を変えたら Web を再起動します（Firebase 設定は実行時に読むので、再ビルドは不要です）。

### 最初の実ログイン確認

1. 公開 URL を開くと `/login` に移り、「Googleでログイン」ボタンが出ることを確かめます。
2. ボタンを押し、許可したGoogleアカウントでログインします。トップに戻り、右上に「ログイン中：（メール）」と「ログアウト」が出れば成功です。
3. 許可していない Google アカウントで試すと「このGoogleアカウントでは使えません。」と出て入れないことを確かめます。
4. 「ログアウト」を押すと `/login` に戻り、`/api/tasks` が 401 になることを確かめます。
5. 「ログインの設定が足りません」と出たら、FIREBASE_* / SESSION_SECRET / ALLOWED_EMAILS のどれかが未設定です。`auth/unauthorized-domain` 相当のエラーなら、承認済みドメインの追加を確認します。


## 関連資料を使う

タスク詳細の「関連資料」で「ファイル」「メモ」「URL」を切り替えます。メモは保存・編集・削除できます。URLはサーバーでタイトルと本文を取得します。失敗してもURLを残し、理由と「再取得」を表示します。再取得に失敗した以前の本文は画面で確認できますが、AI入力には使いません。全資料APIはログインが必要で、変更操作には同一Originを要求します。

メモは題名200字、本文20,000字、URLは2,048字です。タスクごとのメモとURLは合計50件までです。URL取得はHTTPとHTTPSの80・443番だけを許可し、全体10秒、圧縮前後2MiB、転送5回を上限にします。HTMLまたはプレーンテキストから本文50,000字までを保存します。詳しい拒否条件は [アーキテクチャ](ARCHITECTURE.md) に記載しています。

| 環境変数 | 既定 | 動作 |
| --- | --- | --- |
| `REFERENCE_FETCH_MODE` | `live` | 公開ページを実取得する。`off` はURL保存後に取得無効を表示する |
| `REFERENCE_FETCH_MODE=fixture` | 明示指定のみ | 開発検証専用。example.comの合成ページを127.0.0.1:3351から取得する。本番では起動を拒否する |
| `E2E_DATA_DIR` | `data` | Playwright専用DB・blob・成果物の配置先。実行時に検証用データを初期化する |
| `E2E_OUTPUT_DIR` | `test-results` | Playwrightの出力先 |
| `SHOT_DIR` | 関連資料テストで指定 | スクリーンショットの出力先 |

画面の「テスト用データ」はfixtureでの成功です。「実サイトから取得」はliveで成功したURLだけに表示します。ファイルの解析は引き続きモックです。登録メモと取得済みURLは、タスク分解・ドラフト初版・既存の修正指示による改訂に共通の参考データとして渡します。資料本文はAIへの指示や承認として扱いません。

関連資料をローカルで確認する場合は、リポジトリルートで次を実行します。認証設定はGit管理外の環境から供給し、値を表示しません。

```sh
timeout 10m env DATABASE_PATH=/workspace/dev/tp-ref-data/manual/task-planner.sqlite BLOB_DIRECTORY=/workspace/dev/tp-ref-data/manual/blobs ARTIFACT_DIRECTORY=/workspace/dev/tp-ref-data/manual/artifacts REFERENCE_FETCH_MODE=live AI_MODE=mock npm run dev -- --hostname 127.0.0.1 --port 3350
timeout 10m env TMPDIR=/workspace/dev/tp-ref-data/tmp E2E_DATA_DIR=/workspace/dev/tp-ref-data/e2e-reference E2E_OUTPUT_DIR=/workspace/dev/tp-ref-runs/playwright-results SHOT_DIR=/workspace/dev/tp-ref-runs/shots PW_PORT=3350 AI_MODE=mock npx playwright test --config=playwright.references.config.ts
```

DB配置先とTMPDIRはあらかじめ作成します。E2Eでは手動検証や既存利用のDBディレクトリを指定しません。汎用の `playwright.config.ts` は既定の相対パスとポートを使います。関連資料専用設定は検証環境を隔離するガードとして3350とtp-ref-data配下を必須にし、fixtureだけ3351を使います。

分解編集と参考資料のAI入力、専用DBでの検証手順は [分解編集と関連資料の統合検証](docs/REFERENCE_INTEGRATION.md) を参照してください。
