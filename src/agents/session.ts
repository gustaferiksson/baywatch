import {
    chmodSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { $ } from "bun"

import { createAgentClone, pushBranchToMain } from "../agentClone.ts"
import type { BaywatchConfig } from "../config.ts"
import { prepRepo } from "../prep.ts"
import { findSession, SESSIONS_ROOT, type SessionMeta, type SessionRepo, type SessionRow } from "../sessionsState.ts"
import { findTask, readTask, writeTask } from "../tasksState.ts"

const SANDBOX_IMAGE = "baywatch-agent"
const IDENTITY_ROOT = path.join(homedir(), ".baywatch", "identity")
const IDENTITY_CREDS = path.join(IDENTITY_ROOT, ".credentials.json")
// Sibling to .credentials.json. Holds the org/account cache that Remote Control
// reads on startup; without it RC fails with "Unable to determine your organization".
const IDENTITY_CLAUDE_JSON = path.join(IDENTITY_ROOT, ".claude.json")

function shortId(): string {
    return Math.random().toString(36).slice(2, 8)
}

function slugify(s: string): string {
    return s
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 40)
}

// Keys we strip out of the inherited host settings before they get mounted
// into the container. They reference host-only paths or binaries (plugins
// installed under host ~/.claude, MCP servers pointing at host filesystem,
// statusLine commands the container won't have, etc.) and would produce
// noise on every spawn.
const HOST_COUPLED_KEYS: ReadonlySet<string> = new Set([
    "hooks",
    "mcpServers",
    "enabledMcpjsonServers",
    "disabledMcpjsonServers",
    "mcpContextUris",
    "plugins",
    "enabledPlugins",
    "disabledPlugins",
    "statusLine",
    "apiKeyHelper",
    "skills",
    "remoteControlAtStartup", // we set this ourselves
])

// Per-session settings.json bind-mounted into the container as
// ~/.claude/settings.json. Responsibilities:
//   1. Inherit the user's host ~/.claude/settings.json — model preference,
//      effort, theme, permissions, editor mode, etc. — minus the keys that
//      reference host-only paths/binaries (see HOST_COUPLED_KEYS).
//   2. `remoteControlAtStartup: true` → claude auto-registers with claude.ai/code
//      on startup. No `--remote-control` flag, no consent prompt to dismiss; the
//      tmux-hosted interactive session is reachable from web AND local terminal.
//   3. Hooks → append events to ~/.baywatch/session/status.jsonl (host-mounted)
//      so `baywatch session ls` can derive state.
function buildSessionSettings(): string {
    const hostSettingsPath = path.join(homedir(), ".claude", "settings.json")
    const base: Record<string, unknown> = {}
    if (existsSync(hostSettingsPath)) {
        try {
            const parsed = JSON.parse(readFileSync(hostSettingsPath, "utf8")) as Record<string, unknown>
            for (const [key, value] of Object.entries(parsed)) {
                if (!HOST_COUPLED_KEYS.has(key)) base[key] = value
            }
        } catch (err) {
            console.warn(`[session] failed to parse ${hostSettingsPath}: ${(err as Error).message}`)
        }
    }

    const cmd = (event: string) =>
        `printf '{"ts":%s,"event":"${event}"}\\n' "$(date +%s%3N)" >> /home/agent/.baywatch/session/status.jsonl`
    const events = ["SessionStart", "UserPromptSubmit", "Notification", "Stop", "SessionEnd"]
    const hooks: Record<string, unknown> = {}
    for (const e of events) hooks[e] = [{ hooks: [{ type: "command", command: cmd(e) }] }]

    return JSON.stringify({ ...base, remoteControlAtStartup: true, hooks }, null, 2)
}

// Keys we always source from the baywatch identity's .claude.json rather than
// the user's host file. These are auth/account/identity-shaped — using host
// values would either break RC eligibility or conflict with the bootstrap
// login we did under the baywatch identity. Plus host-path-coupled state we
// don't want polluting the container.
const IDENTITY_CLAUDE_JSON_OWNED_KEYS: ReadonlySet<string> = new Set([
    "oauthAccount",
    "userID",
    "anonymousId",
    "subscriptionType",
    "claudeCodeFirstTokenDate",
    "firstStartTime",
    "numStartups",
    "installMethod",
    "migrationVersion",
])

// Keys from host .claude.json that reference host paths or host-installed
// resources — silently dropped so the container doesn't try to chase them.
const HOST_CLAUDE_JSON_STRIP_KEYS: ReadonlySet<string> = new Set(["projects", "githubRepoPaths", "todos"])

// Builds a merged ~/.claude.json that takes the user's host preferences
// (theme, copyOnSelect, tipsHistory, onboarding/hasUsed* flags, …) and layers
// the baywatch identity's auth keys on top so RC keeps working. The result
// is mounted per-session — concurrent sessions don't race on a shared file,
// and host's ~/.claude.json is never touched.
function buildMergedClaudeJson(): string {
    const hostPath = path.join(homedir(), ".claude.json")
    const identityPath = IDENTITY_CLAUDE_JSON

    let identity: Record<string, unknown> = {}
    if (existsSync(identityPath)) {
        try {
            identity = JSON.parse(readFileSync(identityPath, "utf8")) as Record<string, unknown>
        } catch (err) {
            console.warn(`[session] failed to parse ${identityPath}: ${(err as Error).message}`)
        }
    }

    let host: Record<string, unknown> = {}
    if (existsSync(hostPath)) {
        try {
            host = JSON.parse(readFileSync(hostPath, "utf8")) as Record<string, unknown>
        } catch (err) {
            console.warn(`[session] failed to parse ${hostPath}: ${(err as Error).message}`)
        }
    }

    const merged: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(host)) {
        if (HOST_CLAUDE_JSON_STRIP_KEYS.has(key)) continue
        if (IDENTITY_CLAUDE_JSON_OWNED_KEYS.has(key)) continue
        merged[key] = value
    }
    for (const key of IDENTITY_CLAUDE_JSON_OWNED_KEYS) {
        if (key in identity) merged[key] = identity[key]
    }

    return JSON.stringify(merged, null, 2)
}

// Wrapper script run as tmux's initial command. Launches claude; when claude
// exits (Ctrl+D, /exit, or anything else) the user lands in a login shell
// inside the container. From there `claude --resume` opens the picker of
// previous sessions so accidental kills are recoverable without spawning a
// fresh baywatch session.
function buildSessionWrapper(name: string, workdir: string): string {
    const safeName = name.replace(/'/g, "'\\''")
    const safeWorkdir = workdir.replace(/'/g, "'\\''")
    return `#!/bin/sh
cd '${safeWorkdir}'
echo "[baywatch] launching claude. Detach with Ctrl+C (tmux), or /exit to drop to shell."
claude -n '${safeName}'
echo ""
echo "[baywatch] claude exited. Tip: 'claude --resume' to reopen this session."
exec bash --login
`
}

// Encodes an absolute path the same way claude-code names project dirs under
// `~/.claude/projects/`: every character that isn't `[A-Za-z0-9-]` is replaced
// with a dash. Existing dashes are preserved verbatim, no collapsing — so
// `/Users/gustaf/.baywatch/clones/foo--bar` becomes
// `-Users-gustaf--baywatch-clones-foo--bar` (slash-then-dot → `--`, existing
// `--` stays).
function encodeProjectDir(absPath: string): string {
    return absPath.replace(/[^A-Za-z0-9-]/g, "-")
}

// Poll the bind-mounted host projects dir for the first transcript JSONL
// claude writes. Returns its absolute path, or null on timeout. Used to drive
// the resume-link symlink — we can't predict the session UUID up front, so we
// wait for claude to pick one and write the first chunk.
async function extractSessionJsonlPath(hostProjectsDir: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        try {
            const entries = readdirSync(hostProjectsDir)
            const jsonl = entries.find((e) => e.endsWith(".jsonl"))
            if (jsonl) return path.join(hostProjectsDir, jsonl)
        } catch {
            // dir vanished — bail; the caller will skip the symlink
        }
        await Bun.sleep(500)
    }
    return null
}

// Poll the tmux pane briefly for the Remote Control environment URL so we can
// record it in meta.json. Best-effort: returns null if it doesn't appear within
// the timeout (the session is still usable; you just won't have a quick-link).
async function extractRcUrl(containerName: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    // Interactive `claude` prints `claude.ai/code/session_<id>`; server mode
    // prints `claude.ai/code?environment=<env>`. Match either.
    const re = /https:\/\/claude\.ai\/code\/session_[\w-]+|https:\/\/claude\.ai\/code\?environment=[\w-]+/
    while (Date.now() < deadline) {
        const r = await $`podman exec ${containerName} tmux capture-pane -p -t claude`.nothrow().quiet()
        if (r.exitCode === 0) {
            const m = r.stdout.toString().match(re)
            if (m) return m[0]
        }
        await Bun.sleep(500)
    }
    return null
}

function assertIdentity(): void {
    if (!existsSync(IDENTITY_CREDS) || !existsSync(IDENTITY_CLAUDE_JSON)) {
        throw new Error(
            `Baywatch identity not set up — expected both:\n` +
                `  ${IDENTITY_CREDS}\n` +
                `  ${IDENTITY_CLAUDE_JSON}\n` +
                `Run: baywatch session login`
        )
    }
}

// Each session gets its own clone-parent dir. It's identity-mounted into the
// container as a single mount, so every repo clone under it is visible at the
// same path host- and container-side — and a clone dropped in later (add repo
// on the fly) appears live without recreating the container.
function sessionCloneParent(id: string): string {
    return path.join(homedir(), ".baywatch", "clones", id)
}

// A repo to bring into a session: cut a fresh branch off origin/<default>
// (reuse=false), or continue an existing task branch already landed in the main
// clone (reuse=true).
type RepoPlan = {
    ownerRepo: string
    mainClonePath: string
    branch: string
    defaultBranch: string
    reuse: boolean
}

// Spawn one container mounting every repo clone under a per-session parent, with
// claude's cwd at the parent so it sees all repos at once. Writes meta.json and
// returns it. The Task itself is written by the caller.
async function spawnSession(opts: {
    id: string
    name: string
    taskId: string
    plans: RepoPlan[]
}): Promise<SessionMeta> {
    const { id, name, taskId, plans } = opts
    if (plans.length === 0) throw new Error("a session needs at least one repo")

    const sessionDir = path.join(SESSIONS_ROOT, id)
    mkdirSync(sessionDir, { recursive: true })

    const settingsPath = path.join(sessionDir, "settings.json")
    writeFileSync(settingsPath, buildSessionSettings())
    writeFileSync(path.join(sessionDir, "status.jsonl"), "")

    // Clone every repo into a per-session parent dir. The parent is what gets
    // identity-mounted (so a repo added on the fly shows up live), but claude's
    // cwd is the single repo when there's only one — the agent lands *inside*
    // the repo rather than in the parent — and the parent only when there are
    // several.
    const cloneParent = sessionCloneParent(id)
    mkdirSync(cloneParent, { recursive: true })
    const sessionRepos: SessionRepo[] = []
    for (const plan of plans) {
        const clone = await createAgentClone({
            ownerRepo: plan.ownerRepo,
            mainClonePath: plan.mainClonePath,
            branchName: plan.branch,
            defaultBranch: plan.defaultBranch,
            targetDir: cloneParent,
            reuseBranch: plan.reuse,
        })
        sessionRepos.push({
            ownerRepo: plan.ownerRepo,
            branch: plan.branch,
            clonePath: clone.path,
            mainClonePath: plan.mainClonePath,
        })
    }
    const firstRepo = sessionRepos[0]
    const workdir = sessionRepos.length === 1 && firstRepo ? firstRepo.clonePath : cloneParent

    const wrapperPath = path.join(sessionDir, "wrap.sh")
    writeFileSync(wrapperPath, buildSessionWrapper(name, workdir))
    chmodSync(wrapperPath, 0o755)

    // Pre-create the host-side project dir so the bind-mount has somewhere to
    // land. Claude inside the container appends `<uuid>.jsonl` files here, and
    // because both sides share the same path encoding, host claude finds them
    // under their natural location. Keyed on workdir (the recorded cwd).
    const hostProjectsDir = path.join(homedir(), ".claude", "projects", encodeProjectDir(workdir))
    mkdirSync(hostProjectsDir, { recursive: true })
    const containerProjectsDir = `/home/agent/.claude/projects/${encodeProjectDir(workdir)}`

    // Per-session merged .claude.json — host prefs + identity auth. Mounted
    // instead of the identity file directly so parallel sessions can't race
    // on a shared file, and host's ~/.claude.json stays untouched.
    const claudeJsonPath = path.join(sessionDir, "claude.json")
    writeFileSync(claudeJsonPath, buildMergedClaudeJson())

    const containerName = `baywatch-session-${id}`
    const runArgs: string[] = [
        "podman",
        "run",
        "-d",
        "--name",
        containerName,
        "--hostname",
        `baywatch-${id}`,
        // Map host UID → container UID 1000 so the agent user can read/write the
        // bind-mounted clones, credentials, and per-session dir.
        "--userns=keep-id:uid=1000,gid=1000",
        "-w",
        workdir,
        // Auth: bind-mount both the credentials file (refresh chain) and the
        // .claude.json sibling (org/account cache that Remote Control reads).
        // Both rw so token refreshes and cache updates persist back to host;
        // claude-code's lockfile-based config writer serialises concurrent
        // sessions.
        "-v",
        `${IDENTITY_CREDS}:/home/agent/.claude/.credentials.json:rw`,
        "-v",
        `${claudeJsonPath}:/home/agent/.claude.json:rw`,
        "-v",
        `${sessionDir}:/home/agent/.baywatch/session:rw`,
        "-v",
        `${settingsPath}:/home/agent/.claude/settings.json:ro`,
        // One identity mount for the whole clone-parent: every repo clone under
        // it is live (including workdir), and a clone added later shows up
        // without recreating.
        "-v",
        `${cloneParent}:${cloneParent}:rw`,
        // Bind-mount the session's per-cwd projects dir so claude's session
        // transcripts (JSONL) are written straight to the host. The encoded
        // dirname includes the unique session id, so concurrent sessions never
        // collide.
        "-v",
        `${hostProjectsDir}:${containerProjectsDir}:rw`,
        "-e",
        "CLAUDE_CODE_SANDBOXED=1",
        // A real terminal + truecolor so claude renders correct colours inside
        // the container (empty TERM otherwise → the "set COLORTERM" tip).
        "-e",
        "TERM=xterm-256color",
        "-e",
        "COLORTERM=truecolor",
    ]
    // Inherit user-level claude state that's safe to share across containers:
    // CLAUDE.md (user rules), agents/ (custom subagents), skills/ (custom
    // skills). Read-only so concurrent sessions can't corrupt them and host's
    // day-to-day claude isn't surprised by container writes. Skip plugins/,
    // projects/, sessions/, memory/ — those are host-path-coupled.
    const hostClaudeRoot = path.join(homedir(), ".claude")
    const inheritReadOnly = [
        { host: path.join(hostClaudeRoot, "CLAUDE.md"), container: "/home/agent/.claude/CLAUDE.md" },
        { host: path.join(hostClaudeRoot, "agents"), container: "/home/agent/.claude/agents" },
        { host: path.join(hostClaudeRoot, "skills"), container: "/home/agent/.claude/skills" },
    ]
    for (const mount of inheritReadOnly) {
        if (existsSync(mount.host)) {
            runArgs.push("-v", `${mount.host}:${mount.container}:ro`)
        }
    }
    const ghToken = process.env.GITHUB_TOKEN
    if (ghToken) runArgs.push("-e", `GITHUB_TOKEN=${ghToken}`)
    runArgs.push(SANDBOX_IMAGE)

    const runProc = Bun.spawn(runArgs, { stdout: "pipe", stderr: "pipe" })
    const runExit = await runProc.exited
    if (runExit !== 0) {
        const stderr = await new Response(runProc.stderr).text()
        throw new Error(`podman run failed (exit ${runExit}): ${stderr.trim()}`)
    }
    const containerId = (await new Response(runProc.stdout).text()).trim()

    // Launch wrap.sh inside a detached tmux session so:
    //   - the process survives the spawning exec call
    //   - `baywatch session attach` can reattach a real TTY any time
    //   - Remote Control still kicks in (via settings.remoteControlAtStartup),
    //     so the same session is reachable from claude.ai/code
    //   - if claude exits, the user drops to a shell from which they can
    //     `claude --resume` instead of having to spawn a fresh session
    const claudeCmd = `tmux new-session -d -s claude /home/agent/.baywatch/session/wrap.sh`
    await $`podman exec ${containerName} bash -lc ${claudeCmd}`.quiet()

    // Wait for both the RC URL banner and the transcript JSONL in parallel —
    // each polls independently so a slow Remote Control bridge doesn't delay
    // the resume-link, and vice versa.
    const [rcUrl, jsonlPath] = await Promise.all([
        extractRcUrl(containerName, 10_000),
        extractSessionJsonlPath(hostProjectsDir, 15_000),
    ])

    // Drop a resume symlink into each repo's main-clone project dir so
    // `claude --resume` from any of the session's real checkouts lists it. The
    // transcript's recorded `cwd` is the clone-parent, so without these links
    // the session is only discoverable when launching claude from the parent.
    let resumeLinkPath: string | undefined
    if (jsonlPath) {
        for (const repo of sessionRepos) {
            const mainProjectsDir = path.join(homedir(), ".claude", "projects", encodeProjectDir(repo.mainClonePath))
            mkdirSync(mainProjectsDir, { recursive: true })
            const candidate = path.join(mainProjectsDir, path.basename(jsonlPath))
            try {
                if (!existsSync(candidate)) symlinkSync(jsonlPath, candidate)
                resumeLinkPath ??= candidate
            } catch (err) {
                console.warn(`[session] could not create resume-link at ${candidate}: ${(err as Error).message}`)
            }
        }
    }

    const meta: SessionMeta = {
        id,
        taskId,
        name,
        repos: sessionRepos,
        containerName,
        containerId,
        startedAt: Date.now(),
        rcEnvironmentUrl: rcUrl,
        ...(resumeLinkPath ? { resumeLinkPath } : {}),
    }
    writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2))
    return meta
}

// Start a new Task (fresh branches off origin/<default>) across one or more
// repos, and run its first session.
export async function runSession(opts: {
    repos: string[]
    name: string
    config: BaywatchConfig
}): Promise<SessionMeta> {
    const { repos, name, config } = opts
    if (repos.length === 0) throw new Error("a session needs at least one repo")
    assertIdentity()

    const id = shortId()
    const branch = `agent/session-${id}-${slugify(name)}`
    const plans: RepoPlan[] = []
    for (const ownerRepo of repos) {
        const prep = await prepRepo({ ownerRepo, config })
        plans.push({
            ownerRepo,
            mainClonePath: prep.repoPath,
            branch,
            defaultBranch: prep.defaultBranch,
            reuse: false,
        })
    }

    const taskId = shortId()
    writeTask({
        id: taskId,
        name,
        repos: plans.map((p) => ({ ownerRepo: p.ownerRepo, branch: p.branch, mainClonePath: p.mainClonePath })),
        createdAt: Date.now(),
    })

    return spawnSession({ id, name, taskId, plans })
}

// Reopen an existing Task in a fresh session: check out its branches (with the
// commits already landed in the main clones) instead of cutting from default,
// so you can continue a feature — or review it — the next day.
export async function continueSession(opts: {
    taskId: string
    name?: string
    config: BaywatchConfig
}): Promise<SessionMeta> {
    const { taskId, config } = opts
    assertIdentity()

    const task = findTask(taskId)
    if (!task) throw new Error(`no task matching '${taskId}'`)
    if (task.repos.length === 0) throw new Error(`task ${task.id} has no repos`)

    const id = shortId()
    const name = opts.name ?? task.name
    const plans: RepoPlan[] = []
    for (const r of task.repos) {
        const prep = await prepRepo({ ownerRepo: r.ownerRepo, config })
        plans.push({
            ownerRepo: r.ownerRepo,
            mainClonePath: prep.repoPath,
            branch: r.branch,
            defaultBranch: prep.defaultBranch,
            reuse: true,
        })
    }

    return spawnSession({ id, name, taskId: task.id, plans })
}

// Add a repo to a live session on the fly: clone it into the already-mounted
// clone-parent (so it appears in the running container without a restart) and
// record it on both the session and its Task.
export async function addRepoToSession(opts: {
    idOrName: string
    ownerRepo: string
    config: BaywatchConfig
}): Promise<SessionMeta> {
    const { idOrName, ownerRepo, config } = opts
    const session = await findSession(idOrName)
    if (!session) throw new Error(`No session matching '${idOrName}'`)
    if (session.repos.some((r) => r.ownerRepo === ownerRepo)) {
        throw new Error(`${ownerRepo} is already in session ${session.id}`)
    }

    const prep = await prepRepo({ ownerRepo, config })
    // Keep every repo in the session on one branch name.
    const branch = session.repos[0]?.branch ?? `agent/session-${session.id}-${slugify(session.name)}`
    const clone = await createAgentClone({
        ownerRepo,
        mainClonePath: prep.repoPath,
        branchName: branch,
        defaultBranch: prep.defaultBranch,
        targetDir: sessionCloneParent(session.id),
        reuseBranch: false,
    })

    const metaPath = path.join(SESSIONS_ROOT, session.id, "meta.json")
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta
    meta.repos = [...meta.repos, { ownerRepo, branch, clonePath: clone.path, mainClonePath: prep.repoPath }]
    writeFileSync(metaPath, JSON.stringify(meta, null, 2))

    const task = readTask(session.taskId)
    if (task && !task.repos.some((r) => r.ownerRepo === ownerRepo)) {
        task.repos.push({ ownerRepo, branch, mainClonePath: prep.repoPath })
        writeTask(task)
    }

    return meta
}

// Reattach a real TTY to the container's tmux session. Replaces this process —
// when the user detaches (Ctrl+B D) or claude exits, control returns to their
// shell. Throws if the container is dead or the tmux session is gone.
export async function attachSession(idOrName: string): Promise<never> {
    const session = await findSession(idOrName)
    if (!session) throw new Error(`No session matching '${idOrName}'`)
    if (process.stdin.isTTY !== true) {
        throw new Error(`session attach requires a TTY (this isn't one)`)
    }

    const aliveCheck = await $`podman ps -q --filter name=${session.containerName}`.nothrow().quiet()
    if (!aliveCheck.stdout.toString().trim()) {
        throw new Error(
            `container ${session.containerName} is not running — restart with \`podman start ${session.containerName}\` or remove with \`baywatch session rm ${session.id}\``
        )
    }

    // Replace this Bun process with podman exec so the TTY plumbing is direct
    // and the user's terminal owns the tmux session cleanly. execvp-style via
    // Bun.spawnSync wouldn't replace the process; node's process.exit after
    // proc.exited is the next best thing.
    const proc = Bun.spawn(["podman", "exec", "-it", session.containerName, "tmux", "attach", "-t", "claude"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    })
    const code = await proc.exited
    process.exit(code)
}

export async function stopSession(idOrName: string): Promise<SessionRow> {
    const session = await findSession(idOrName)
    if (!session) throw new Error(`No session matching '${idOrName}'`)
    await syncBranchToMainClone(session)
    await $`podman stop ${session.containerName}`.nothrow().quiet()
    return session
}

export async function removeSession(idOrName: string): Promise<SessionRow> {
    const session = await findSession(idOrName)
    if (!session) throw new Error(`No session matching '${idOrName}'`)
    await syncBranchToMainClone(session)
    // Stop first (idempotent) so rm doesn't fail on a running container.
    await $`podman stop ${session.containerName}`.nothrow().quiet()
    await $`podman rm -f ${session.containerName}`.nothrow().quiet()
    rmSync(path.join(SESSIONS_ROOT, session.id), { recursive: true, force: true })
    return session
}

// Fetch each repo's agent branch from its clone back into the user's real
// checkout, so they can `git checkout <branch>` in their normal workspace.
// Local ref fetch only — never a push, never touches the working tree.
// Best-effort per repo — a fetch failure on one never blocks stop/rm.
async function syncBranchToMainClone(session: SessionRow): Promise<void> {
    for (const repo of session.repos) {
        try {
            const result = await pushBranchToMain({
                path: repo.clonePath,
                mainClonePath: repo.mainClonePath,
                branch: repo.branch,
            })
            if (result.synced) {
                console.log(`[session] ${repo.branch} fetched into ${repo.mainClonePath}`)
            } else {
                console.log(
                    `[session] ${repo.branch} had no commits beyond origin/HEAD — not bringing it into ${repo.mainClonePath}`
                )
            }
        } catch (err) {
            console.warn(
                `[session] could not sync ${repo.branch} back to ${repo.mainClonePath}: ${(err as Error).message}`
            )
        }
    }
}

// Reads the per-session settings.json (no-op currently — exposed so callers can
// confirm hooks are wired before reporting state).
export function readSessionSettings(id: string): string {
    return readFileSync(path.join(SESSIONS_ROOT, id, "settings.json"), "utf8")
}

// One-time setup for the baywatch identity used by all sandboxed sessions.
//
// Spawns a probe container with both ~/.baywatch/identity/.credentials.json and
// ~/.baywatch/identity/.claude.json bind-mounted, then execs `claude auth login`
// interactively so the caller's terminal drives the browser OAuth flow. After
// login completes, both files are populated on the host and persist for future
// session containers to bind-mount.
//
// Sign in with your normal claude.ai account — Anthropic issues a separate
// OAuth grant per `claude auth login` invocation, so your host login stays
// untouched.
export async function loginSession(opts: { force: boolean }): Promise<void> {
    const alreadySetUp =
        existsSync(IDENTITY_CREDS) &&
        statSync(IDENTITY_CREDS).size > 0 &&
        existsSync(IDENTITY_CLAUDE_JSON) &&
        statSync(IDENTITY_CLAUDE_JSON).size > 1

    if (alreadySetUp && !opts.force) {
        console.log(`Already logged in (${IDENTITY_ROOT}). Use --force to re-login.`)
        return
    }

    mkdirSync(IDENTITY_ROOT, { recursive: true })
    if (!existsSync(IDENTITY_CREDS)) writeFileSync(IDENTITY_CREDS, "")
    // claude rejects an empty .claude.json as corrupt JSON ("Unexpected EOF"),
    // so seed with `{}` before the bind-mount.
    if (!existsSync(IDENTITY_CLAUDE_JSON) || statSync(IDENTITY_CLAUDE_JSON).size <= 1) {
        writeFileSync(IDENTITY_CLAUDE_JSON, "{}\n")
    }

    const containerName = "baywatch-session-login"
    await $`podman rm -f ${containerName}`.nothrow().quiet()

    const runArgs = [
        "podman",
        "run",
        "-d",
        "--name",
        containerName,
        "--userns=keep-id:uid=1000,gid=1000",
        "-e",
        "CLAUDE_CODE_SANDBOXED=1",
        "-v",
        `${IDENTITY_CREDS}:/home/agent/.claude/.credentials.json:rw`,
        "-v",
        `${IDENTITY_CLAUDE_JSON}:/home/agent/.claude.json:rw`,
        SANDBOX_IMAGE,
    ]
    const runProc = Bun.spawn(runArgs, { stdout: "pipe", stderr: "pipe" })
    if ((await runProc.exited) !== 0) {
        const stderr = await new Response(runProc.stderr).text()
        throw new Error(`podman run failed: ${stderr.trim()}`)
    }

    console.log("Running `claude auth login` inside the baywatch container.")
    console.log("Follow the browser prompt — credentials will land in:")
    console.log(`  ${IDENTITY_CREDS}`)
    console.log(`  ${IDENTITY_CLAUDE_JSON}`)
    console.log()

    const execProc = Bun.spawn(["podman", "exec", "-it", containerName, "claude", "auth", "login"], {
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
    })
    const execExit = await execProc.exited

    await $`podman rm -f ${containerName}`.nothrow().quiet()

    if (execExit !== 0) throw new Error(`claude auth login failed (exit ${execExit})`)
    if (statSync(IDENTITY_CREDS).size === 0) {
        throw new Error(`Login finished but ${IDENTITY_CREDS} is empty.`)
    }

    console.log()
    console.log("✓ baywatch session login complete.")
}
