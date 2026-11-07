# データモデル

Taskが唯一の管理対象です。以下の技術データはTaskへ紐付きます。

| エンティティ | 主な項目 | 用途 |
| --- | --- | --- |
| Task | id、title、description、category、task_type、deadline、prepare_by、remind_at、status、ai_status、revision | タスクと期限の管理 |
| TaskInput | id、task_id、type、content、created_at | テキスト、音声、画像、PDF入力 |
| ExecutionJob | id、task_id、job_type、status、scheduled_at、retry_count、idempotency_key、lease_until | 再開可能な非同期実行 |
| Artifact | id、task_id、current_version_id、approved_version_id | 成果物と現在版・承認版 |
| ArtifactVersion | id、artifact_id、version_number、parent_version_id、content_snapshot_reference、user_rating、approval_status | 不変のドラフトスナップショット |
| Feedback | id、artifact_version_id、content、applied_to_version_id | 版に紐づく修正指示 |
| QualityRule | id、content、source_feedback_id、enabled | 明示または反復確認済みの品質ルール |
| Notification | id、task_id、scheduled_at、status、mode、idempotency_key | 通知予定と配信結果 |
| SyncEvent | id、task_id、field、base_value、remote_revision、status | 同期差分と競合記録 |
| SourceReference | id、task_id、category、permission_scope、expires_at | 許可範囲と出典の記録 |
| ExternalActionApproval | id、task_id、target_id、content_hash、operation、expires_at、used_at | 外部操作の個別承認 |

Task statusはOPEN、IN_PROGRESS、COMPLETED、CANCELLEDです。ai_statusはNOT_REQUIRED、WAITING_CONFIRMATION、QUEUED、RUNNING、READY、FAILED、CANCELLEDです。Good評価、成果物の最終承認、タスク完了、外部操作承認は独立しています。

各サービス接続はmode、connection_status、疎通確認日時、権限範囲を持ちます。秘密値そのものはDBや画面に保存しません。モックIDは実サービスIDと区別します。
