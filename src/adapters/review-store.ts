import Database from 'better-sqlite3';
import { z } from 'zod';

export const ratingSchema = z.enum(['UNRATED', 'GOOD', 'BAD']);
export const approvalSchema = z.enum(['UNAPPROVED', 'APPROVED', 'REVOKED']);
export type Rating = z.infer<typeof ratingSchema>;
export type Approval = z.infer<typeof approvalSchema>;

const reviewRowSchema = z.object({ version_id: z.string().uuid(), user_rating: ratingSchema, approval_status: approvalSchema });

export class ReviewStore {
  private readonly db: Database.Database;

  constructor(databasePath: string) {
    this.db = new Database(databasePath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS artifact_reviews (
      version_id TEXT PRIMARY KEY, user_rating TEXT NOT NULL DEFAULT 'UNRATED', approval_status TEXT NOT NULL DEFAULT 'UNAPPROVED'
    );`);
  }

  rate(versionId: string, rating: Rating): void {
    this.requireSavedVersion(versionId);
    const value = ratingSchema.parse(rating);
    this.db.prepare(`INSERT INTO artifact_reviews(version_id, user_rating, approval_status) VALUES (?, ?, 'UNAPPROVED')
      ON CONFLICT(version_id) DO UPDATE SET user_rating = excluded.user_rating`).run(versionId, value);
  }

  rating(versionId: string): Rating {
    this.requireSavedVersion(versionId);
    const row = this.db.prepare('SELECT version_id, user_rating, approval_status FROM artifact_reviews WHERE version_id = ?').get(versionId);
    return row ? reviewRowSchema.parse(row).user_rating : 'UNRATED';
  }

  approveFinal(versionId: string): void {
    const version = this.requireSavedVersion(versionId);
    this.db.transaction(() => {
      this.db.prepare(`UPDATE artifact_reviews SET approval_status = 'REVOKED'
        WHERE version_id IN (SELECT id FROM artifact_versions WHERE artifact_id = ?)
          AND approval_status = 'APPROVED' AND version_id != ?`).run(version.artifact_id, versionId);
      this.db.prepare(`INSERT INTO artifact_reviews(version_id, user_rating, approval_status) VALUES (?, 'UNRATED', 'APPROVED')
        ON CONFLICT(version_id) DO UPDATE SET approval_status = 'APPROVED'`).run(versionId);
      this.db.prepare('UPDATE artifacts SET approved_version_id = ? WHERE id = ?').run(versionId, version.artifact_id);
    }).immediate();
  }

  revokeApproval(versionId: string): void {
    const version = this.requireSavedVersion(versionId);
    this.db.transaction(() => {
      this.db.prepare("UPDATE artifact_reviews SET approval_status = 'REVOKED' WHERE version_id = ? AND approval_status = 'APPROVED'").run(versionId);
      this.db.prepare('UPDATE artifacts SET approved_version_id = NULL WHERE id = ? AND approved_version_id = ?').run(version.artifact_id, versionId);
    }).immediate();
  }

  approval(versionId: string): Approval {
    this.requireSavedVersion(versionId);
    const row = this.db.prepare('SELECT version_id, user_rating, approval_status FROM artifact_reviews WHERE version_id = ?').get(versionId);
    return row ? reviewRowSchema.parse(row).approval_status : 'UNAPPROVED';
  }

  searchGood(query: string, category: string): Array<{ taskId: string; title: string; versionId: string; content: string; mode: 'mock' }> {
    const needle = z.string().trim().min(1).max(200).parse(query).toLocaleLowerCase('ja');
    const allowedCategory = z.enum(['WORK', 'PERSONAL', 'STUDY']).parse(category);
    const rows = z.array(z.object({ task_id: z.string().uuid(), title: z.string(), id: z.string().uuid(), content: z.string() }))
      .parse(this.db.prepare(`SELECT tasks.id AS task_id, tasks.title, artifact_versions.id, artifact_versions.content
        FROM artifact_versions JOIN artifacts ON artifacts.id = artifact_versions.artifact_id
        JOIN tasks ON tasks.id = artifacts.task_id JOIN artifact_reviews ON artifact_reviews.version_id = artifact_versions.id
        WHERE tasks.category = ? AND artifact_reviews.user_rating = 'GOOD' AND artifact_versions.save_status = 'MOCK_SAVED'
        ORDER BY artifact_versions.created_at DESC`).all(allowedCategory));
    return rows.filter((row) => `${row.title}\n${row.content}`.toLocaleLowerCase('ja').includes(needle))
      .map((row) => ({ taskId: row.task_id, title: row.title, versionId: row.id, content: row.content, mode: 'mock' }));
  }

  close(): void { this.db.close(); }

  private requireSavedVersion(versionId: string): { artifact_id: string } {
    const row = this.db.prepare("SELECT artifact_id FROM artifact_versions WHERE id = ? AND save_status = 'MOCK_SAVED'").get(versionId);
    return z.object({ artifact_id: z.string().uuid() }).parse(row);
  }
}
