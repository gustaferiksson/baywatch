// Thin wrappers around `execFile baywatch ...`. Anything the extension wants from baywatch
// goes through here so the CLI surface stays the single source of truth.

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as vscode from "vscode"

import type { DoctorCheck, IssueRef, PrRef, RunDetail, RunEntry, RunStatus } from "./types.js"

const execFileAsync = promisify(execFile)

const BUFFER = 8 * 1024 * 1024

async function runJson<T>(args: string[]): Promise<T> {
    const { stdout } = await execFileAsync("baywatch", args, { maxBuffer: BUFFER })
    return JSON.parse(stdout) as T
}

export async function listRuns(opts: { limit?: number; running?: boolean } = {}): Promise<RunEntry[]> {
    const args = ["logs", "--json", "--limit", String(opts.limit ?? 50)]
    if (opts.running) args.push("--running")
    return runJson<RunEntry[]>(args)
}

export async function getRun(runId: number): Promise<RunDetail | null> {
    try {
        return await runJson<RunDetail>(["logs", String(runId), "--json"])
    } catch (err) {
        void vscode.window.showErrorMessage(`baywatch logs ${runId} failed: ${(err as Error).message}`)
        return null
    }
}

export async function listIssueRefs(): Promise<IssueRef[]> {
    return runJson<IssueRef[]>(["list", "issues", "--json"])
}

export async function listPrRefs(): Promise<PrRef[]> {
    return runJson<PrRef[]>(["list", "prs", "--json"])
}

export async function getNotePath(ref: string): Promise<string> {
    const { stdout } = await execFileAsync("baywatch", ["notes", ref, "--path"], { maxBuffer: BUFFER })
    return stdout.trim()
}

export async function readNote(ref: string): Promise<string> {
    const { stdout } = await execFileAsync("baywatch", ["notes", ref, "--print"], { maxBuffer: BUFFER })
    if (stdout.startsWith("(no notes for ")) return ""
    return stdout
}

export async function writeNote(ref: string, content: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
        const child = execFile("baywatch", ["notes", ref, "--write"], { maxBuffer: BUFFER }, (err) => {
            if (err) reject(err)
            else resolve()
        })
        child.stdin?.write(content)
        child.stdin?.end()
    })
}

export function statusColor(status: RunStatus): vscode.ThemeColor | undefined {
    if (status === "running") return new vscode.ThemeColor("charts.blue")
    if (status === "success") return new vscode.ThemeColor("charts.green")
    if (status === "failed") return new vscode.ThemeColor("charts.red")
    return undefined
}

export function statusIcon(status: RunStatus): string {
    if (status === "running") return "loading~spin"
    if (status === "success") return "check"
    if (status === "failed") return "error"
    return "circle-slash"
}

// Run `baywatch doctor` and return the parsed checks. baywatch doctor doesn't have a --json
// mode (yet) — parse the human-readable output. Falls back to a single failure entry on error.
export async function runDoctor(): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
    try {
        const { stdout } = await execFileAsync("baywatch", ["doctor"], { maxBuffer: BUFFER })
        return parseDoctorOutput(stdout)
    } catch (err) {
        // `baywatch doctor` exits non-zero on any failure — execFile rejects but stdout is on the error.
        const e = err as NodeJS.ErrnoException & { stdout?: string }
        if (e.stdout) return parseDoctorOutput(e.stdout)
        return {
            checks: [
                {
                    name: "baywatch CLI",
                    status: "fail",
                    detail: (err as Error).message,
                    hint: "is `baywatch` on your PATH?",
                },
            ],
            ok: false,
        }
    }
}

function parseDoctorOutput(stdout: string): { checks: DoctorCheck[]; ok: boolean } {
    const checks: DoctorCheck[] = []
    let pending: DoctorCheck | null = null
    for (const rawLine of stdout.split("\n")) {
        const line = rawLine.trimEnd()
        const match = line.match(/^([✓!✗])\s+(.+?)\s{2,}(.+)$/)
        if (match) {
            if (pending) checks.push(pending)
            const sym = match[1]
            const status: DoctorCheck["status"] = sym === "✓" ? "ok" : sym === "!" ? "warn" : "fail"
            pending = { name: match[2]?.trim() ?? "", status, detail: match[3]?.trim() ?? "" }
            continue
        }
        const hintMatch = line.match(/^\s+→\s+(.+)$/)
        if (hintMatch && pending) pending.hint = hintMatch[1]?.trim() ?? ""
    }
    if (pending) checks.push(pending)
    return { checks, ok: checks.every((c) => c.status !== "fail") }
}
