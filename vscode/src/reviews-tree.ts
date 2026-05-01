import { execFile } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import * as vscode from "vscode"

const execFileAsync = promisify(execFile)

export type ReviewEntry = {
    name: string
    path: string
    mtime: Date
    ownerRepo: string
    prNumber: number
    submitScript: string | null
}

export class ReviewsTreeDataProvider implements vscode.TreeDataProvider<ReviewEntry> {
    private readonly _onDidChangeTreeData = new vscode.EventEmitter<ReviewEntry | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event

    refresh(): void {
        this._onDidChangeTreeData.fire(undefined)
    }

    getTreeItem(review: ReviewEntry): vscode.TreeItem {
        const item = new vscode.TreeItem(`${review.ownerRepo}#${review.prNumber}`)
        const ageMin = Math.floor((Date.now() - review.mtime.getTime()) / 60_000)
        item.description = ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin / 60)}h ago`
        item.tooltip = review.path
        item.iconPath = new vscode.ThemeIcon("comment-discussion")
        item.contextValue = "review"
        item.command = {
            command: "vscode.open",
            title: "Open review",
            arguments: [vscode.Uri.file(review.path)],
        }
        return item
    }

    async getChildren(): Promise<ReviewEntry[]> {
        const dir = await reviewsDir()
        if (!dir || !existsSync(dir)) return []
        return readdirSync(dir)
            .filter((f) => f.endsWith(".md") && !f.endsWith("__submit-review.sh"))
            .map((f): ReviewEntry => {
                const full = path.join(dir, f)
                const parsed = parseReviewFilename(f)
                const submit = path.join(dir, f.replace(/\.md$/, "__submit-review.sh"))
                return {
                    name: f,
                    path: full,
                    mtime: statSync(full).mtime,
                    ownerRepo: parsed.ownerRepo,
                    prNumber: parsed.prNumber,
                    submitScript: existsSync(submit) ? submit : null,
                }
            })
            .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
    }
}

// Filenames look like `owner__repo__123.md` — invert the flatten.
function parseReviewFilename(file: string): { ownerRepo: string; prNumber: number } {
    const stem = file.replace(/\.md$/, "")
    const m = stem.match(/^(.+)__(\d+)$/)
    if (!m?.[1] || !m[2]) return { ownerRepo: stem, prNumber: 0 }
    const ownerRepoFlat = m[1]
    const prNumber = Number.parseInt(m[2], 10)
    // owner__repo → owner/repo (just first __ — repo names don't contain __ in practice)
    const idx = ownerRepoFlat.indexOf("__")
    if (idx === -1) return { ownerRepo: ownerRepoFlat, prNumber }
    return { ownerRepo: `${ownerRepoFlat.slice(0, idx)}/${ownerRepoFlat.slice(idx + 2)}`, prNumber }
}

let cachedDir: string | null = null

async function reviewsDir(): Promise<string | null> {
    if (cachedDir) return cachedDir
    try {
        // Trick: ask the CLI for its install root by reading any ref's note path and trimming.
        // Simpler: call `baywatch logs --json --limit 1` then any review's path → parent dir.
        // Cleanest: introduce `baywatch root --reviews-dir` later. For now read from `baywatch logs --json`.
        const { stdout } = await execFileAsync("baywatch", ["logs", "--json", "--limit", "50"], {
            maxBuffer: 4 * 1024 * 1024,
        })
        const runs = JSON.parse(stdout) as Array<{ kind: string; logPath: string | null }>
        const review = runs.find((r) => r.kind === "review" && r.logPath !== null)
        if (review?.logPath) {
            // logPath is in <main-clone>/.sandcastle/logs/...; reviews dir is BAYWATCH_ROOT/reviews
            // Easier: derive from the binary location — call baywatch directly with a custom command later.
        }
        // Fallback: use the well-known location relative to the bin.
        const { stdout: which } = await execFileAsync("which", ["baywatch"], { maxBuffer: 1024 })
        // which baywatch → ~/.bun/bin/baywatch (symlink to <repo>/src/cli.ts in dev install)
        const real = await execFileAsync("readlink", ["-f", which.trim()])
        const realPath = real.stdout.trim()
        // realPath: /Users/.../baywatch/src/cli.ts → repo root is two dirs up
        cachedDir = path.join(path.dirname(path.dirname(realPath)), "reviews")
        return cachedDir
    } catch {
        return null
    }
}
