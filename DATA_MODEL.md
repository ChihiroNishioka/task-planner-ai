# データモデル

Taskが唯一の管理対象です。以下の技術データはTaskへ紐付きます。

| エンティティ | 主な項目 | 用途 |
| --- | --- | --- |
| Task | id、title、description、category、task_type、deadline、prepare_by、remind_at、status、completed_at、ai_status、revision | タスクと期限の管理 |
| TaskInput | id、task_id、type、content、created_at | テキスト、音声、画像、PDF入力 |
| ExecutionJob | id、task_id、job_type、status、scheduled_at、retry_count、idempotency_key、lease_until | 再開可能な非同期実行 |
| Artifact | id、task_id、current_version_id、approved_version_id | 成果物と現在版・承認版 |
| ArtifactVersion | id、artifact_id、version_number、parent_version_id、content_snapshot_reference、user_rating、approval_status | 不変のドラフトスナップショット |
| ArtifactReview | version_id、user_rating、approval_status | 評価と最終承認をタスク完了から分離 |
| Feedback | id、artifact_version_id、content、applied_to_version_id | 版に紐づく修正指示 |
| QualityRule | id、content、source_feedback_id、enabled | 明示または反復確認済みの品質ルール |
| Notification | id、task_id、scheduled_at、status、mode、idempotency_key | 通知予定と配信結果 |
| TaskSchedule | id、task_id、revision、deadline、start_at、prepare_by、review_by、remind_at、status | 期限に合わせた実行予定 |
| SyncEvent | id、task_id、field、base_value、remote_revision、status | 同期差分と競合記録 |
| SourceReference | id、task_id、category、permission_scope、expires_at | 許可範囲と出典の記録 |
| ExternalActionApproval | id、task_id、target_id、content_hash、operation、expires_at、used_at | 外部操作の個別承認 |

Task statusはOPEN、IN_PROGRESS、COMPLETED、CANCELLEDです。ai_statusはNOT_REQUIRED、WAITING_CONFIRMATION、QUEUED、RUNNING、READY、FAILED、CANCELLEDです。Good評価、成果物の最終承認、タスク完了、外部操作承認は独立しています。

`Task.completed_at` はCOMPLETEDのときだけISO日時を持ち、APIでは `completedAt` として返します。完了へ変更した時刻を保存し、再開または中止でNULLに戻します。同状態への再送では日時・revision・updated_atを変えません。状態の競合はexpectedStatusで検出し、revisionは進行系と終了系をまたぐ変更でだけ増やします。

SQLiteのTaskStore起動時に `completed_at TEXT` を追加し、毎回1つのimmediateトランザクションで整合性を修復します。既存COMPLETEDでNULLの場合はupdated_atを近似完了日時として採用し、他状態で値がある場合はNULLにします。revision・updated_at・予定・通知は移行で変えません。予定・通知表はTaskStore単体でも初期化します。

完了・中止は待機予定と未配信通知をCANCELLEDにします。再開では最新の停止予定だけを同じ締切・見積りで再計算して新revisionを作ります。実行済み予定の停止通知は未来の締切の場合だけ同じ行をSCHEDULEDに戻します。締切が現在以前なら復帰せず、配信済み履歴は維持します。判定と副作用はTaskStore.changeStatusの1つのimmediateトランザクションで行います。

旧新版の混在動作は保証しません。投入時はworker、webの順で両方停止し、DBと-wal/-shmを退避してから新版をweb、workerの順に起動します。起動後はCOMPLETEDでcompleted_atがNULLの行と、他状態でcompleted_atを持つ行が0件であることを確認します。切り戻しはコードのみとし、追加列は削除しません。退避DBへの復元は投入後の変更を失うため最終手段です。

各サービス接続はmode、connection_status、疎通確認日時、権限範囲を持ちます。秘密値そのものはDBや画面に保存しません。モックIDは実サービスIDと区別します。

現在のSQLite実装ではTaskとTaskInputのファイルメタデータを保存し、blob本体をローカルディレクトリへ保存します。解析状態は `NOT_PROCESSED` で、画像解析・PDF解析・音声認識は未実装です。

Phase 3ではExecutionJob、WorkPlan、Artifact、ArtifactVersionをSQLiteへ保存します。成果物ファイルはローカルディレクトリへ置き、modeは `mock`、保存状態は `MOCK_SAVED` とします。Google Drive保存とは扱いません。

Phase 4ではTaskScheduleとNotificationをSQLiteへ保存します。期限変更時に以前の予約と未配信通知を取消します。通知箱の状態は `MOCK_DELIVERED` で、実メールを送信しません。

Phase 5では修正指示を前版へ結び付け、改訂版を追加します。Good検索はcategoryが一致する保存済み版だけを返します。品質ルールの自動学習と生成時の自動再利用は未実装です。


## メモ・URLの永続化

`ReferenceStore` は起動時に `task_references` と `task_references_task` インデックスを `CREATE ... IF NOT EXISTS` で追加します。既存テーブルの削除・列変更・既存行の書き換えは行いません。既存DBと同じSQLiteファイルに追加し、タスクとの対応は `task_id` で保持します。

| 項目 | 内容 |
| --- | --- |
| `id`, `task_id`, `kind` | 資料ID、所属タスク、NOTEまたはURL |
| `title`, `body`, `url`, `final_url` | メモまたは抽出テキスト、登録URL、最終URL |
| `revision`, `created_at`, `updated_at` | 資料単位の編集競合検出と時刻。Taskのrevisionとは独立 |
| `operation_key`, `request_hash` | 同じタスク・操作キーの再送を一つにする。別内容での再利用は409 |
| `fetch_status`, `fetch_error_code`, `fetch_mode` | FETCHING・SUCCEEDED・FAILED、固定の失敗コード、liveまたはfixture |
| `fetch_attempt_id`, `fetch_started_at`, `fetched_at` | 取得試行IDと開始・成功時刻。古い試行からの確定を拒否 |
| `content_type`, `truncated` | 本文種別と保存時の切り詰め有無 |

メモ編集には現在のrevisionが必要です。削除は資料行を物理削除し、後着の取得結果で復活させません。30秒を過ぎたFETCHINGは次回参照時にFAILED・INTERRUPTEDへ回復します。取得失敗は以前のタイトル・本文を保持しますが、AI利用はNOTEとSUCCEEDEDのURL本文だけです。タスクが存在しない場合はAPIと既存生成処理で拒否します。


## 分解とドラフトの接続

`DraftFlowStore` は既存DBに別接続し、`busy_timeout=5000` を設定します。既存表の列変更、既存行の補完・書き換えは行いません。次の表とインデックスを `IF NOT EXISTS` で追加します。

| 表 | 主な項目 | 用途 |
| --- | --- | --- |
| `draft_version_links` | `artifact_version_id` 主キー、`task_id`、nullableな `breakdown_version_id`、`source`、`created_at` | ドラフト版が基準とした分解版。`source` は `CREATE` または `REVISE` |
| `draft_jobs` | `id` 主キー、`task_id`、`status`、`error_code`、`breakdown_version_id`、`request_key`、`task_revision`、`created_at`、`updated_at` | 永続化したドラフト作成ジョブ |

`draft_version_links_task` と `draft_queue` が検索を支えます。`UNIQUE(task_id, request_key)` が再送を同じジョブへ結び付けます。部分一意インデックス `draft_jobs_one_active` は、タスクごとの `QUEUED` または `RUNNING` を1件に制限します。`task_revision INTEGER NOT NULL` は受付時のタスクrevisionです。取得時と保存直前に照合し、完了後に再開した場合も古いジョブを復活させません。

初回の準備ジョブは分解版だけを追加します。ドラフト作成は保存済み分解版を入力として、artifactとリンクを同じトランザクションで追加します。改訂では最新の分解を入力へ渡しますが、分解版を追加しません。改訂版の基準版は親から継承します。作成と改訂ではタスクのrevisionとai_statusを変更しません。

読み取り時の追跡は `TRACKED`、`INFERRED`、`UNKNOWN` です。リンクがあれば記録された基準版を使います。旧版では `breakdown_versions.source_artifact` と一致する分解版があれば推定し、それ以外は不明とします。基準版が見つからない場合も不明です。基準版と最新分解の手順を順序込みで比較し、異なる場合に変更案内を出します。不明の場合は変更案内を出しません。この判定でDBには書き込みません。

`BreakdownStore` も `draft_version_links` の同じDDLを持ち、リンクのあるartifactを `syncArtifacts` の対象から除外します。これにより、ドラフト閲覧で編集済み分解が古い手順へ戻ることを防ぎます。既存のリンクなしartifactの取り込みは従来どおりです。

本番の差し替えは本作業の対象外です。実施時にはworker、webの順に停止し、DBと `-wal`、`-shm` を退避してから、web、workerの順に起動します。旧workerと新webの混在ではドラフトジョブは待機したままです。旧webには新しい作成ボタンがありません。

切り戻しではコードだけを旧版に戻せません。`breakdown-store.ts` のリンク表・インデックスのDDLと、`syncArtifacts` のリンク付きartifact除外の1行を残した切り戻しコミットを使います。新表は削除しません。両プロセスを停止して切り替え、既存ドラフトの閲覧後も分解の最新版が変わらないことを確認します。退避DBへの復元は投入後の変更を失うため、最終手段です。

## 画像の提案と確認した読み取り結果

`ImageProposalStore` と `InputStore` は、`image_proposals` と `task_input_analyses` および待機順インデックス `image_proposals_queue` を `CREATE IF NOT EXISTS` で追加します。この変更による既存表のALTERと既存行の補完はありません。

`image_proposals` は操作キーと要求ハッシュ、画像情報、メモ、候補JSON、実行モード、失敗理由、実行tokenとlease、確認済み入力とハッシュ、作成tokenとlease、タスクID、有効期限を持ちます。状態は `QUEUED`、`RUNNING`、`READY`、`CREATING`、`CONSUMED` です。AI失敗は `READY` と `mock_fallback` および失敗理由で表します。

作成受付はimmediateトランザクションで確認値を固定します。タスク作成は `image-proposal:<id>` を操作キーにし、添付blobは `<提案ID>.blob` に固定します。停止後は同じ確認値で再開し、別の確認値は拒否します。作成中の提案は削除と期限切れ掃除から保護します。lease切れはGETとworkerの掃除で復旧し、画像欠落時は `createStuck` を返します。

`task_input_analyses` は `input_id` を主キーに、`task_id`、`mode`、`extracted_text`、`proposal_id`、`created_at` を保持します。実AIで読み取り、利用者が確認した空でない文だけ保存します。分析行のある入力は `EXTRACTED`、ない入力は `NOT_PROCESSED` です。入力一覧APIは分析状態だけを返し、本文を返しません。

未使用提案は24時間、使用済み行は7日で掃除します。作成済みに遷移すると候補JSON、メモ、確認済みJSONを消し、再送判定のハッシュを残します。元画像は保持せず、正規化JPEGだけを保存します。

投入は本作業の範囲外です。実施時は新版のbuildを別checkoutで済ませ、worker、webの順に停止します。停止確認後にDB、`-wal`、`-shm`、blobディレクトリを退避し、web、workerの順に起動します。旧workerと新webの混在は保証しません。切り戻しは両方を停止し、基点 `8ee2bbd` へ戻します。新表は削除しません。退避DBへの復元は投入後の変更を失います。

## URL取得の詳細と旧版互換

`ReferenceStore` は `ensureColumn` で `fetch_failure_reason TEXT NULL`、`content_hint TEXT NULL`、`fetch_detail_revision INTEGER NULL`、`fetch_http_status INTEGER NULL` を追加します。最後の列が既にあれば追加しません。初期化で既存行は書き換えません。

`fetch_error_code` は従来の12値を維持します。詳細理由は名前解決の未検出・失敗、安全拒否の宛先・形式、HTTPの拒否・未検出・サーバー・その他を別列へ保存します。APIでは任意の `fetchFailureReason` と `contentHint` を返し、HTTP状態の数値は返しません。未知の詳細値はnullとして読みます。理由とコードが不一致ならコードの文言を使います。

開始・成功・失敗・中断回復は、revisionの更新と同じUPDATEで `fetch_detail_revision=revision+1` を書きます。読み取りでは両revisionが一致するときだけ詳細理由とcontentHintを採用します。旧版が更新するとrevisionだけが進み、古い詳細は無効になります。

開始・成功・回復は詳細理由とHTTP状態をnullへ戻します。成功はcontentHintをnullも含めて上書きします。失敗時は以前の本文とcontentHintを保持します。古い試行の確定や削除後の復活を拒否する条件は維持します。

`content_hint` は `SHORT_BODY` または `PAYWALL_HINT` です。HTML本文が600コードポイント未満なら短文、2,000未満で手掛かりがある場合は有料等の可能性を優先します。本文を切り詰めた場合とtext/plainにはhintを付けません。古い行は再取得までnullです。

旧版更新で無効になったcontentHintは、開始・失敗・回復の更新時にもnullへ落とします。stampの更新だけで古い注意表示が復活することを防ぎます。
