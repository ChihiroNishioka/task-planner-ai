# アーキテクチャ

## 構成

Next.jsの単一アプリをUIとAPIに使い、ドメイン処理と外部サービス境界を分けます。現在のローカル実装はSQLiteでタスクを永続化します。PostgreSQLとPrismaによる共有環境、非同期ワーカーは後続実装です。初期実装はローカルで動くモックアダプターを使います。

```mermaid
flowchart LR
  UI[Web UI] --> API[Next.js API]
  API --> DOMAIN[ドメイン処理]
  DOMAIN --> DB[(SQLite local)]
  DOMAIN --> BLOBS[(local file volume)]
  WORKER[Node.js worker] --> DB
  DOMAIN --> ADAPTER[サービス別アダプター]
  ADAPTER --> MOCK[永続モック]
  ADAPTER -. 明示設定と権限確認後 .-> REAL[実サービス]
```

## 境界と安全

API入口で入力をZod検証します。現在はAPI認証が未実装のため、`npm run start` はlocalhostにだけbindします。Compose構成を公開環境へ使わないでください。モックは外向き通信をしません。サービス状態はAPIと画面に個別のmode、connection_status、labelで示します。認証と権限確認の両方が成功するまで実接続済みとは表示しません。

メール送信や外部確定操作には操作ごとの承認記録を要求します。承認は対象・内容ハッシュ・操作種別・期限に結び付け、実行直前に再検証します。既定では無効です。

## 実装範囲

単一ユーザーのタスクを中心にします。タスク以外の独立したIdeaやProject管理は作りません。Notionはタスク同期、Google Driveは成果物保存の将来の正本です。資格情報が無い間は対応するモックを使い、実接続失敗をモック成功に置き換えません。

## 運用

`npm run dev` はWebアプリを起動します。Composeはアプリを起動し、SQLiteファイルと添付blobを名前付きボリュームへ保存します。PostgreSQLとワーカーは未実装です。
