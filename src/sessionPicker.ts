import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { isCancel, select, text } from "@clack/prompts"

import type { BaywatchConfig } from "./config.ts"
import { listSessions, type SessionRow, type SessionState } from "./sessionsState.ts"

const ICON: Record<SessionState, string> = {
    "awaiting-input": "⚠",
    working: "●",
    starting: "◐",
    idle: "○",
    failed: "✗",
    done: "✓",
    stopped: "·",
}

// Things needing attention (or alive) come first; finished/dead last.
const ORDER: readonly SessionState[] = [
    "awaiting-input",
    "working",
    "starting",
    "idle",
    "failed",
    "done",
    "stopped",
]

export type PickResult =
    | { kind: "session"; row: SessionRow }
    | { kind: "new"; repo: string; name: string }
    | null

// Walks each cloneRoot for direct children that contain a .git dir, and surfaces
// them as `<cloneRoot-basename>/<repo>` — the same `owner/repo` shape baywatch's
// other commands accept (e.g. `Gustaf/baywatch` for `~/Repos/Gustaf/baywatch`).
function discoverLocalRepos(config: BaywatchConfig): string[] {
    const refs = new Set<string>()
    for (const root of config.cloneRoots) {
        if (!existsSync(root)) continue
        const owner = path.basename(root)
        let entries: string[]
        try {
            entries = readdirSync(root)
        } catch {
            continue
        }
        for (const entry of entries) {
            const repoPath = path.join(root, entry)
            try {
                if (!statSync(repoPath).isDirectory()) continue
            } catch {
                continue
            }
            if (!existsSync(path.join(repoPath, ".git"))) continue
            refs.add(`${owner}/${entry}`)
        }
    }
    return [...refs].sort()
}

// fzf if available — fuzzy filtering is the right ergonomics for many items.
// Fallback: two-step "type to filter, then select" using clack primitives.
async function pickFromList(items: string[], prompt: string): Promise<string | null> {
    const which = await $`which fzf`.nothrow().quiet()
    const fzfAvailable = which.exitCode === 0

    if (fzfAvailable) {
        const proc = Bun.spawn(["fzf", "--prompt", `${prompt}: `, "--height", "40%", "--reverse"], {
            stdin: "pipe",
            stdout: "pipe",
            stderr: "inherit",
        })
        proc.stdin.write(`${items.join("\n")}\n`)
        proc.stdin.end()
        const code = await proc.exited
        if (code !== 0) return null
        const out = (await new Response(proc.stdout).text()).trim()
        return out || null
    }

    // Fallback path. Recommend fzf once so users know there's a better UX
    // available; non-blocking, just a hint.
    console.log("(tip: `brew install fzf` for fuzzy-search in this picker)")

    const filter = await text({
        message: `${prompt} (type to filter, blank for all):`,
        placeholder: "e.g. baywatch",
    })
    if (isCancel(filter)) return null

    const q = (filter as string).trim().toLowerCase()
    const filtered = q ? items.filter((i) => i.toLowerCase().includes(q)) : items

    if (filtered.length === 0) {
        console.log(`No matches for "${q}".`)
        return null
    }
    if (filtered.length === 1) return filtered[0] ?? null

    const result = await select<string>({
        message: `${prompt}:`,
        options: filtered.map((r) => ({ value: r, label: r })),
    })
    return isCancel(result) ? null : (result as string)
}

async function pickNewSession(config: BaywatchConfig): Promise<PickResult> {
    const repos = discoverLocalRepos(config)
    if (repos.length === 0) {
        console.log(
            `No local clones found under: ${config.cloneRoots.join(", ")}\n` +
                `Add a clone or update cloneRoots in baywatch.config.ts.`
        )
        return null
    }

    const repo = await pickFromList(repos, "Repo")
    if (!repo) return null

    const nameInput = await text({
        message: "Name (blank for auto):",
        placeholder: "fix-auth-flow",
    })
    if (isCancel(nameInput)) return null

    const repoName = repo.split("/")[1] ?? "session"
    const autoName = `${repoName}-${Date.now().toString(36).slice(-4)}`
    const name = (nameInput as string).trim() || autoName

    return { kind: "new", repo, name }
}

export async function pickSession(config: BaywatchConfig): Promise<PickResult> {
    const all = await listSessions()
    const sessions = [...all].sort(
        (a, b) =>
            ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || b.lastEventAt - a.lastEventAt
    )

    if (sessions.length === 0) return pickNewSession(config)

    type Choice = { _: "session"; row: SessionRow } | { _: "new" }
    const nameWidth = Math.max(...sessions.map((s) => s.name.length), 12)

    const result = await select<Choice>({
        message: "Pick a session:",
        options: [
            ...sessions.map((s) => ({
                value: { _: "session" as const, row: s },
                label: `${ICON[s.state]}  ${s.name.padEnd(nameWidth)}  ${s.repos.map((r) => r.ownerRepo).join(", ")}`,
                hint: s.state,
            })),
            { value: { _: "new" as const }, label: "+ Start new session…" },
        ],
    })

    if (isCancel(result)) return null
    if (result._ === "new") return pickNewSession(config)
    return { kind: "session", row: result.row }
}
