# Task Planner AI

個人向けのタスク管理Webアプリです。現在の実装は認証情報なしで動くモックMVPです。Notion、Google Drive、Gmail、Google Calendar、音声認識、AI、通知は実サービスへ接続しません。

## 起動

Node.js 24 と npm を使います。

```sh
npm ci
npm run dev
```

ブラウザーで `http://localhost:3000` を開きます。設定値は `.env.example` を参考に `.env.local` へ設定します。秘密値は空のままにし、実値をソースやログへ書かないでください。

## 開発確認

```sh
npm test
npm run lint
npm run typecheck
```

`npm test` は現在20件のVitest確認を実行します。

Docker Compose を使う場合は `docker compose up --build` を実行します。Dockerが無い環境ではnpmから起動できます。SQLiteのファイルは `data/task-planner.sqlite` に保存します。

## 機能と制約

Phase 1ではタスクをSQLiteに保存し、一覧・登録・詳細・編集・完了・延期・論理削除を使えます。Phase 2では画像、PDF、音声ファイルをタスクに添付し、ローカル領域へ保存できます。ファイル解析と音声文字起こしは未実装で、画面にモックと表示します。Phase 3では「AI準備を依頼」から永続ジョブを登録し、別ターミナルで `timeout 1h npm run worker` を起動すると、決定的なAIモックが作業計画とMarkdown版を保存します。`npm run worker -- --once` は次のジョブを1件だけ処理します。実AI、Drive連携、実サービスへの保存は行いません。API認証はまだありません。`npm run start` はlocalhostにだけbindします。Docker Composeは開発用で、公開環境では使わないでください。将来の接続手順とデータ構造は [ARCHITECTURE.md](ARCHITECTURE.md) と [DATA_MODEL.md](DATA_MODEL.md) を参照してください。

## 開発の段階

Phase 0 は設計と環境、Phase 1 はタスク管理、Phase 2 は入力、Phase 3 は準備とドラフト、Phase 4 は期限と通知、Phase 5 はレビューと再利用、Phase 6 は統合検証を扱います。完了した範囲と実行した検証は `/workspace/dev/task-planner-ai/.runs/impl-result.md` に記録します。
