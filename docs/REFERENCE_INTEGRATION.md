# 分解編集と関連資料の統合検証

分解の編集・版管理・コメントによる作り直しと、関連資料のファイル・メモ・URLを同じタスク詳細で扱う。

`BreakdownStore` は未保存の手順とコメントを永続ジョブに保存する。ワーカーが実行直前に `withReferences` を通り、そのタスクの現在の資料を取得する。キュー投入後に編集したメモも対象になる。別タスクと削除済み資料は含めない。取得失敗URLはURLと未取得表示だけを渡し、古い本文を使用しない。

`PreparationAdapter.breakdown` に任意の資料引数を追加した。`generate` と `revise` と同じ `buildReferenceBlock` を使い、資料全体を20,000字以内に制限する。参考データは指示ではないと明示し、ランダムな区切り、山括弧の全角化、行ごとの引用で区切り偽装に備える。資料が無い場合の既存プロンプトは保持する。CLI失敗時は未保存の手順を保ち、`mock_fallback` と理由を返す。

分解の版・復元・冪等キー・競合検査と、既存のドラフト・レビューを併用できる。関連資料は `task_references` 表とindexの追加だけで保存し、既存列や既存行は書き換えない。移行テストでは分解版、未実行ジョブ、冪等キーも含めて既存schemaと行を比較する。

Astryxのcore・theme 0.7.11、stylex 0.19.1を使う。両パネルは公開 `ThemeContext` とsectionの属性で局所的にテーマを適用する。`html` にテーマを設定しない。

## 単体・移行テストを実行する

リポジトリルートで実行する。単体・統合・移行テストの一時DBは `os.tmpdir()` 配下に作る。`TMPDIR` で専用の一時ディレクトリに変更できる。既定の `npm test` はCIのcheckoutディレクトリでも実行でき、固定のworkspaceパスを必要としない。CLI・ソケット・子プロセスのテストを含むため、プロセス起動とローカル待受を許可した環境を使う。

認証情報を含まない検証用の環境で次を実行する。

```sh
timeout 180s npm test
timeout 30s node scripts/secret-scan.mjs
```

## 隔離した環境で画面を検証する

`playwright.integration.config.ts` は共存E2Eと分解・AIレビュー・既存UI、関連資料・認証テストを集める。アプリは3350、ローカルfixtureは3351を使う。両ポートを使用中なら開始しない。

専用の `playwright.references.config.ts` と `playwright.integration.config.ts` の固定パスは、この検証環境用の配置ガードである。DBは `/workspace/dev/tp-ref-data/`、統合検証のログと画像は `/workspace/dev/tp-ref-runs/` の子ディレクトリだけを許可する。汎用の `playwright.config.ts` は相対パスを既定とし、`PW_PORT`、`E2E_DATA_DIR`、`E2E_OUTPUT_DIR` で別checkoutでも配置を選べる。関連資料のスクリーンショットは `SHOT_DIR` 未指定なら `test-results/` 配下に保存する。

```sh
timeout 10s mkdir -p /workspace/dev/tp-ref-data/integration-tmp /workspace/dev/tp-ref-data/integration-e2e /workspace/dev/tp-ref-runs/integration-shots
timeout 600s env PW_PORT=3350 E2E_WEB_AI=0 AI_MODE=mock TMPDIR=/workspace/dev/tp-ref-data/integration-tmp E2E_DATA_DIR=/workspace/dev/tp-ref-data/integration-e2e E2E_OUTPUT_DIR=/workspace/dev/tp-ref-runs/integration-e2e SHOT_DIR=/workspace/dev/tp-ref-runs/integration-shots node_modules/.bin/playwright test --config=playwright.integration.config.ts
```

この実行では `E2E_WEB_AI` が無効なので、改訂AI成功とfallbackの390px・1280pxの計4件はskipになる。実行結果ではpassed・skipped・failedを分け、skipを合格に含めない。

4件を実行するには、リポジトリルートで次を別途実行する。`AI_CLI_PATH` は同じcheckoutの偽CLIを明示する。`unsafeWebAiEnv` が偽CLI以外の実CLI指定を拒否するガードを維持する。実AIやAPIキーは使わない。

```sh
timeout 180s env PW_PORT=3350 E2E_WEB_AI=1 AI_MODE=cli AI_CLI=claude AI_CLI_PATH="$PWD/tests/fixtures/fake-ai-cli.mjs" AI_TIMEOUT_MS=10000 TMPDIR=/workspace/dev/tp-ref-data/integration-tmp E2E_DATA_DIR=/workspace/dev/tp-ref-data/integration-e2e E2E_OUTPUT_DIR=/workspace/dev/tp-ref-runs/integration-revise-e2e SHOT_DIR=/workspace/dev/tp-ref-runs/integration-shots node_modules/.bin/playwright test --config=playwright.integration.config.ts tests/ui.spec.ts --grep 'revision (from feedback|falls back)'
```

E2E初期化は指定先の `playwright.sqlite`、blob、成果物を消去するため、専用の検証ディレクトリだけを指定する。手動確認用DBや利用中DBを指定しない。専用configはDB・ログ・画像の配置先を検査する。DBはtp-ref-data、成果ログと画像はtp-ref-runsへ保存する。

関連資料E2Eは390pxの入力中・保存・編集・削除・URL成功・URL失敗・切替と1280px画像を撮る。共存E2Eは390pxと1280pxでメモ・URL保存中の未保存分解保持、分解保存・復元後の資料保持、再読込とメモ編集削除、横幅と局所テーマを確認する。スクリーンショットと実行結果を合わせて確認する。

URL成功はローカルfixture成功、AI成功は偽CLIまたは注入runner成功と明示する。これらのテストは実サイト取得や実AIの成功を証明しない。実サイトのDNS・TLS・本文取得は、別の接続確認として記録する。
