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
