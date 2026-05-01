import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const STATE_DIR = path.join(homedir(), ".baywatch")
const DB_PATH = path.join(STATE_DIR, "state.db")

let _db: Database | null = null

export function getDb(): Database {
    if (_db) return _db
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const db = new Database(DB_PATH)
    db.exec("PRAGMA journal_mode = WAL")
    migrate(db)
    _db = db
    return db
}

function migrate(db: Database): void {
    db.exec(`
        CREATE TABLE IF NOT EXISTS reviews (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner_repo TEXT NOT NULL,
            pr_number INTEGER NOT NULL,
            head_sha TEXT NOT NULL,
            reviewed_at INTEGER NOT NULL,
            review_path TEXT NOT NULL,
            submitted_at INTEGER,
            UNIQUE (owner_repo, pr_number, head_sha)
        );

        CREATE TABLE IF NOT EXISTS runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('dev', 'review')),
            owner_repo TEXT NOT NULL,
            target TEXT NOT NULL,
            branch TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'cancelled')),
            log_path TEXT
        );
    `)
}

export type ReviewRecord = {
    id: number
    ownerRepo: string
    prNumber: number
    headSha: string
    reviewedAt: number
    reviewPath: string
    submittedAt: number | null
}

type ReviewRow = {
    id: number
    owner_repo: string
    pr_number: number
    head_sha: string
    reviewed_at: number
    review_path: string
    submitted_at: number | null
}

function rowToReview(row: ReviewRow): ReviewRecord {
    return {
        id: row.id,
        ownerRepo: row.owner_repo,
        prNumber: row.pr_number,
        headSha: row.head_sha,
        reviewedAt: row.reviewed_at,
        reviewPath: row.review_path,
        submittedAt: row.submitted_at,
    }
}

export function getLatestReviewFor(ownerRepo: string, prNumber: number): ReviewRecord | null {
    const stmt = getDb().query(
        `SELECT * FROM reviews WHERE owner_repo = ? AND pr_number = ? ORDER BY reviewed_at DESC LIMIT 1`
    )
    const row = stmt.get(ownerRepo, prNumber) as ReviewRow | null
    return row ? rowToReview(row) : null
}

export function recordReview(rec: Omit<ReviewRecord, "id" | "submittedAt">): void {
    const stmt = getDb().query(
        `INSERT INTO reviews (owner_repo, pr_number, head_sha, reviewed_at, review_path)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (owner_repo, pr_number, head_sha)
         DO UPDATE SET reviewed_at = excluded.reviewed_at, review_path = excluded.review_path`
    )
    stmt.run(rec.ownerRepo, rec.prNumber, rec.headSha, rec.reviewedAt, rec.reviewPath)
}
