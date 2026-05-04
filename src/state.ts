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
    // WAL allows concurrent readers + one writer; busy_timeout makes briefly-contended
    // reads (e.g. the VS Code extension polling `baywatch logs --json` while an agent
    // is mid-completeRun) wait instead of erroring with SQLITE_BUSY.
    db.exec("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA busy_timeout = 5000")
    db.exec("PRAGMA synchronous = NORMAL")
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
            log_path TEXT,
            agent_clone_path TEXT,
            review_path TEXT
        );
    `)

    // For databases created before later columns existed, add them idempotently.
    const cols = (db.query("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name)
    if (!cols.includes("agent_clone_path")) db.exec("ALTER TABLE runs ADD COLUMN agent_clone_path TEXT")
    if (!cols.includes("review_path")) db.exec("ALTER TABLE runs ADD COLUMN review_path TEXT")
    if (!cols.includes("error_summary")) db.exec("ALTER TABLE runs ADD COLUMN error_summary TEXT")

    const reviewCols = (db.query("PRAGMA table_info(reviews)").all() as { name: string }[]).map((c) => c.name)
    if (!reviewCols.includes("verdict")) db.exec("ALTER TABLE reviews ADD COLUMN verdict TEXT")
}

import type { ReviewVerdict } from "./reviewVerdict.ts"

export type ReviewRecord = {
    id: number
    ownerRepo: string
    prNumber: number
    headSha: string
    reviewedAt: number
    reviewPath: string
    submittedAt: number | null
    verdict: ReviewVerdict
}

type ReviewRow = {
    id: number
    owner_repo: string
    pr_number: number
    head_sha: string
    reviewed_at: number
    review_path: string
    submitted_at: number | null
    verdict: string | null
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
        verdict: (row.verdict as ReviewVerdict) ?? null,
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
        `INSERT INTO reviews (owner_repo, pr_number, head_sha, reviewed_at, review_path, verdict)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_repo, pr_number, head_sha)
         DO UPDATE SET
            reviewed_at = excluded.reviewed_at,
            review_path = excluded.review_path,
            verdict = excluded.verdict`
    )
    stmt.run(rec.ownerRepo, rec.prNumber, rec.headSha, rec.reviewedAt, rec.reviewPath, rec.verdict)
}

// ----- runs -----

export type RunKind = "dev" | "review"
export type RunStatus = "running" | "success" | "failed" | "cancelled"

export type RunRecord = {
    id: number
    kind: RunKind
    ownerRepo: string
    target: string
    branch: string | null
    startedAt: number
    finishedAt: number | null
    status: RunStatus
    logPath: string | null
    agentClonePath: string | null
    reviewPath: string | null
    errorSummary: string | null
}

type RunRow = {
    id: number
    kind: RunKind
    owner_repo: string
    target: string
    branch: string | null
    started_at: number
    finished_at: number | null
    status: RunStatus
    log_path: string | null
    agent_clone_path: string | null
    review_path: string | null
    error_summary: string | null
}

function rowToRun(row: RunRow): RunRecord {
    return {
        id: row.id,
        kind: row.kind,
        ownerRepo: row.owner_repo,
        target: row.target,
        branch: row.branch,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        status: row.status,
        logPath: row.log_path,
        agentClonePath: row.agent_clone_path,
        reviewPath: row.review_path,
        errorSummary: row.error_summary,
    }
}

export function startRun(opts: {
    kind: RunKind
    ownerRepo: string
    target: string
    branch?: string | null
    agentClonePath?: string | null
    reviewPath?: string | null
}): number {
    const stmt = getDb().query(
        `INSERT INTO runs (kind, owner_repo, target, branch, started_at, status, agent_clone_path, review_path)
         VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`
    )
    const result = stmt.run(
        opts.kind,
        opts.ownerRepo,
        opts.target,
        opts.branch ?? null,
        Date.now(),
        opts.agentClonePath ?? null,
        opts.reviewPath ?? null
    )
    return Number(result.lastInsertRowid)
}

export function completeRun(
    id: number,
    opts: { status: RunStatus; logPath?: string | null; errorSummary?: string | null }
): void {
    // Guard on status='running' so a `baywatch stop` that already transitioned the run to
    // 'cancelled' isn't clobbered by the parent process catching the container kill and then
    // calling completeRun(..., 'failed') in its own catch block. Cancellation wins.
    const stmt = getDb().query(
        `UPDATE runs SET status = ?, finished_at = ?, log_path = COALESCE(?, log_path), error_summary = COALESCE(?, error_summary) WHERE id = ? AND status = 'running'`
    )
    stmt.run(opts.status, Date.now(), opts.logPath ?? null, opts.errorSummary ?? null, id)
}

export function cancelRun(id: number): boolean {
    const stmt = getDb().query(
        `UPDATE runs SET status = 'cancelled', finished_at = ?, error_summary = COALESCE(error_summary, 'cancelled by user') WHERE id = ? AND status = 'running'`
    )
    const result = stmt.run(Date.now(), id)
    return result.changes > 0
}

export function getRun(id: number): RunRecord | null {
    const stmt = getDb().query(`SELECT * FROM runs WHERE id = ?`)
    const row = stmt.get(id) as RunRow | null
    return row ? rowToRun(row) : null
}

export function listRuns(opts: { limit?: number; status?: RunStatus } = {}): RunRecord[] {
    const limit = opts.limit ?? 50
    const sql = opts.status
        ? `SELECT * FROM runs WHERE status = ? ORDER BY started_at DESC LIMIT ?`
        : `SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`
    const stmt = getDb().query(sql)
    const rows = (opts.status ? stmt.all(opts.status, limit) : stmt.all(limit)) as RunRow[]
    return rows.map(rowToRun)
}
