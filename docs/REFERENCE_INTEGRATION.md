# main統合後の分解編集と関連資料

統合対象は origin/main の `defbc0e2d11f703fcbd2a02eff2f1bf1b4a91fc6`。分解の編集・版管理・コメントによる作り直しと、関連資料のファイル・メモ・URLを同じタスク詳細で扱う。

`BreakdownStore` は未保存の手順とコメントを永続ジョブに保存する。ワーカーが実行直前に `withReferences` を通り、そのタスクの現在の資料を取得する。キュー投入後に編集したメモも対象になる。別タスクと削除済み資料は含めない。取得失敗URLはURLと未取得表示だけを渡し、古い本文を使用しない。

`PreparationAdapter.breakdown` に任意の資料引数を追加した。`generate` と `revise` と同じ `buildReferenceBlock` を使い、資料全体を20,000字以内に制限する。参考データは指示ではないと明示し、ランダムな区切り、山括弧の全角化、行ごとの引用で区切り偽装に備える。資料が無い場合の既存プロンプトは保持する。CLI失敗時は未保存の手順を保ち、`mock_fallback` と理由を返す。

分解の版・復元・冪等キー・競合検査と、既存のドラフト・レビューはmainの処理を維持する。関連資料は `task_references` 表とindexの追加だけで保存し、既存列や既存行は書き換えない。移行テストでは分解版、未実行ジョブ、冪等キーも含めて既存schemaと行を比較する。

Astryxはmainと同じcore・theme 0.7.11、stylex 0.19.1を使い、依存追加は不要。両パネルは公開 `ThemeContext` とsectionの属性で局所的にテーマを適用する。`html` にテーマを設定しない既存UI条件を保つ。

## 通常Shellで検証する

Codexの担当は実装と待受不要の対象単体テスト、lint、型チェックまで。build、全体CLIテスト、秘密走査、実socket、Playwrightは通常Shellで実行する。今回の実行結果は `/workspace/dev/tp-ref-runs/integration-result.md` に記録する。

作業ディレクトリは `/workspace/dev/tp-ref`。秘密環境を除去済みの通常Shellを使う。以下を一つずつ実行し、非0なら原因と同理由の失敗回数を記録する。最初の意図したREDを含め2回なら停止する。環境由来の待受EPERMとinstall timeoutは回数に含めず、成功にも扱わない。

```sh
timeout 10s mkdir -p /workspace/dev/tp-ref-data/integration-tmp /workspace/dev/tp-ref-data/integration-e2e /workspace/dev/tp-ref-runs/integration-shots
timeout 180s env TMPDIR=/workspace/dev/tp-ref-data/integration-tmp node_modules/.bin/vitest run
timeout 30s node scripts/secret-scan.mjs
timeout 180s env TMPDIR=/workspace/dev/tp-ref-data/integration-tmp AI_MODE=mock REFERENCE_FETCH_MODE=off DATABASE_PATH=/workspace/dev/tp-ref-data/integration-build/task-planner.sqlite BLOB_DIRECTORY=/workspace/dev/tp-ref-data/integration-build/blobs ARTIFACT_DIRECTORY=/workspace/dev/tp-ref-data/integration-build/artifacts npm run build
```

`playwright.integration.config.ts` は共存E2Eとmainの分解・AIレビュー・既存UI、関連資料・認証テストを集める。アプリは3350、ローカルfixtureは3351を使う。両ポートを他作業者が使用中なら開始せず調整する。既存プロセスを停止しない。汎用設定の既定値は変えない。

```sh
timeout 180s env PW_PORT=3350 AI_MODE=mock TMPDIR=/workspace/dev/tp-ref-data/integration-tmp E2E_DATA_DIR=/workspace/dev/tp-ref-data/integration-e2e E2E_OUTPUT_DIR=/workspace/dev/tp-ref-runs/integration-private-url SHOT_DIR=/workspace/dev/tp-ref-runs/integration-shots node_modules/.bin/playwright test --config=playwright.integration.config.ts tests/references.spec.ts --grep 'メモ下書き保持、保存、編集、削除とURL取得状態'
timeout 600s env PW_PORT=3350 AI_MODE=mock TMPDIR=/workspace/dev/tp-ref-data/integration-tmp E2E_DATA_DIR=/workspace/dev/tp-ref-data/integration-e2e E2E_OUTPUT_DIR=/workspace/dev/tp-ref-runs/integration-e2e SHOT_DIR=/workspace/dev/tp-ref-runs/integration-shots node_modules/.bin/playwright test --config=playwright.integration.config.ts
```

最初のコマンドでprivate URL行の選択修正を確認する。この項目は前回同理由1回の失敗を引き継ぐ。同じ理由で再失敗したら、全体E2Eへ進まない。

E2E初期化は指定先の `playwright.sqlite`、blob、成果物を消去するため、専用の検証ディレクトリだけを指定する。手動確認用DBや利用中DBを指定しない。専用configはDB・ログ・画像の配置先を検査する。DBはtp-ref-data、成果ログと画像はtp-ref-runsへ保存する。

既存の関連資料E2Eは390pxの入力中・保存・編集・削除・URL成功・URL失敗・切替と1280px画像を撮る。共存E2Eは390pxと1280pxでメモ・URL保存中の未保存分解保持、分解保存・復元後の資料保持、再読込とメモ編集削除、横幅と局所テーマを確認する。スクリーンショットの存在だけでGREENにせず、通常Shell担当が画面と実行結果を確認する。

URL成功はローカルfixture成功、AI成功は偽CLIまたは注入runner成功と明示する。今回のテストは実サイト取得や実AIの成功を証明しない。実サイトの取得成功は未確認のままにする。
