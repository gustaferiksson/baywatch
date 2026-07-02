#!/usr/bin/env bun
import {
    addRepoToSession,
    attachSession,
    continueSession,
    loginSession,
    removeSession,
    runSession,
    stopSession,
} from "./agents/session.ts"
import { formatSize, listCloneCandidates, parseDuration, removeClone } from "./clean.ts"
import { BAYWATCH_ROOT, loadConfig } from "./config.ts"
import { printDoctorReport, runDoctor } from "./doctor.ts"
import { installSpecs } from "./install-specs.ts"
import { pickSession } from "./sessionPicker.ts"
import { findSession, listSessions } from "./sessionsState.ts"

const HELP = `baywatch — task-centric, multi-repo agent cockpit

USAGE
  baywatch <command> [options]

COMMANDS
  session [<id|name>]                         Pick a sandboxed Claude session (no args + TTY → picker)
  session login [--force]                     One-time setup: log the baywatch identity into Claude
  session new <owner/repo>... [--name <n>]    Start a session across one or more repos (new task)
  session continue <taskId> [--name <n>]      Reopen a task's branches in a fresh session
  session add-repo <id|name> <owner/repo>     Add a repo to a live session (no restart)
  session ls [--json]                         List sandboxed sessions
  session attach <id|name>                    Reattach a TTY to a running session's tmux/claude
  session stop <id|name>                      Stop a session's container (keeps clone + metadata)
  session rm <id|name>                        Stop + delete a session entirely
  image-build                                 Rebuild the baywatch-agent podman image
  clean clones [--older-than 14d] [--dry-run] Remove ~/.baywatch/clones/ entries older than threshold (skips live sessions)
  doctor                                      Pre-flight: gh auth, podman machine, image, env tokens, config
  install-specs                               Build & install Fig autocomplete spec
  -h, --help                                  Show this help
`

const printHelpAndExit = (): never => {
    process.stdout.write(HELP)
    process.exit(0)
}

// ----- clean -----

const runClean = async (argv: string[]): Promise<void> => {
    const sub = argv[0]
    if (sub !== "clones") {
        throw new Error(`unknown 'clean' subcommand: ${sub ?? "(missing)"} — expected 'clones'`)
    }
    let olderThan = "14d"
    let dryRun = false
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--dry-run") dryRun = true
        else if (a === "--older-than") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--older-than requires a value (e.g. 14d, 24h, 30m)")
            olderThan = v
            i++
        } else if (a === "-h" || a === "--help") printHelpAndExit()
        else throw new Error(`unknown 'clean clones' arg: ${a}`)
    }

    const olderThanMs = parseDuration(olderThan)
    // In-use clones belong to sessions whose container is still alive. Gather
    // them here (session domain) and hand the paths to the filesystem scanner.
    const aliveStates = new Set(["starting", "working", "awaiting-input", "idle"])
    const sessions = await listSessions()
    const inUsePaths = new Set(
        sessions.filter((s) => aliveStates.has(s.state)).flatMap((s) => s.repos.map((r) => r.clonePath))
    )
    const candidates = listCloneCandidates({ olderThanMs, dryRun }, inUsePaths)
    if (candidates.length === 0) {
        console.log(`No clones older than ${olderThan} in ~/.baywatch/clones/.`)
        return
    }

    const removable = candidates.filter((c) => !c.inUse)
    const skipped = candidates.filter((c) => c.inUse)
    const totalBytes = removable.reduce((sum, c) => sum + c.sizeBytes, 0)

    console.log(`${removable.length} clone(s) older than ${olderThan} (${formatSize(totalBytes)}):`)
    for (const c of removable) {
        const age = Math.floor((Date.now() - c.mtime.getTime()) / 86_400_000)
        console.log(`  ${age.toString().padStart(3)}d  ${formatSize(c.sizeBytes).padEnd(8)}  ${c.path}`)
    }
    if (skipped.length > 0) {
        console.log(`\nSkipping ${skipped.length} clone(s) tied to live sessions:`)
        for (const c of skipped) console.log(`  (in-use)  ${c.path}`)
    }

    if (dryRun) {
        console.log("\n(dry-run) nothing removed.")
        return
    }
    for (const c of removable) removeClone(c)
    console.log(`\n✓ Removed ${removable.length} clone(s), reclaimed ${formatSize(totalBytes)}.`)
}

// ----- image-build -----

const runImageBuild = async (): Promise<void> => {
    const containerfile = `${BAYWATCH_ROOT}/Containerfile`
    console.log(`Building baywatch-agent from ${containerfile}`)
    const proc = Bun.spawn(["podman", "build", "-t", "baywatch-agent", "-f", "Containerfile", "."], {
        cwd: BAYWATCH_ROOT,
        stdout: "inherit",
        stderr: "inherit",
    })
    const code = await proc.exited
    if (code !== 0) throw new Error(`podman build failed (exit ${code})`)
    console.log("✓ baywatch-agent rebuilt")
}

// ----- session subcommands -----

const REPO_RE = /^[^/]+\/[^/]+$/

const runSessionCmd = async (argv: string[]): Promise<void> => {
    const sub = argv[0]
    if (sub === "-h" || sub === "--help") {
        printHelpAndExit()
        return
    }
    switch (sub) {
        case "new":
            await runSessionNew(argv.slice(1))
            return
        case "login": {
            const force = argv.slice(1).includes("--force")
            await loginSession({ force })
            return
        }
        case "ls":
            await runSessionLs(argv.slice(1))
            return
        case "attach": {
            const target = argv[1]
            if (!target) throw new Error("session attach requires <id|name>")
            await attachSession(target)
            return
        }
        case "stop": {
            const target = argv[1]
            if (!target) throw new Error("session stop requires <id|name>")
            const s = await stopSession(target)
            console.log(`✓ ${s.id} stopped`)
            return
        }
        case "rm": {
            const target = argv[1]
            if (!target) throw new Error("session rm requires <id|name>")
            const s = await removeSession(target)
            console.log(`✓ ${s.id} removed`)
            return
        }
        case "continue": {
            const target = argv[1]
            if (!target) throw new Error("session continue requires <taskId>")
            const rest = argv.slice(2)
            let name: string | undefined
            for (let i = 0; i < rest.length; i++) {
                if (rest[i] === "--name") {
                    name = rest[i + 1]
                    i++
                }
            }
            const config = await loadConfig()
            const meta = await continueSession({ taskId: target, ...(name ? { name } : {}), config })
            console.log(`✓ session ${meta.id} started — task ${meta.taskId}`)
            if (meta.rcEnvironmentUrl) console.log(`  ${meta.rcEnvironmentUrl}`)
            if (process.stdin.isTTY === true) await attachSession(meta.id)
            return
        }
        case "add-repo": {
            const target = argv[1]
            const repo = argv[2]
            if (!target || !repo) throw new Error("session add-repo requires <id|name> <owner/repo>")
            const config = await loadConfig()
            const meta = await addRepoToSession({ idOrName: target, ownerRepo: repo, config })
            console.log(`✓ added ${repo} to session ${meta.id} (${meta.repos.length} repos)`)
            return
        }
        case undefined:
            await runSessionPick(null)
            return
        default:
            // Treat bare arg as id/name: `baywatch session ab12cd`
            await runSessionPick(sub)
    }
}

const runSessionNew = async (argv: string[]): Promise<void> => {
    const repos: string[] = []
    let name: string | null = null
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        if (a === "--name") {
            const v = argv[i + 1]
            if (v === undefined) throw new Error("--name requires a value")
            name = v
            i++
        } else if (a === "-h" || a === "--help") {
            printHelpAndExit()
        } else if (a !== undefined && !a.startsWith("-")) {
            if (!REPO_RE.test(a)) throw new Error(`bad repo (expected owner/name): ${a}`)
            repos.push(a)
        } else {
            throw new Error(`unknown arg: ${a}`)
        }
    }
    if (repos.length === 0) throw new Error("session new requires at least one owner/repo argument")
    const config = await loadConfig()
    const firstName = repos[0]?.split("/")[1] ?? "session"
    const sessionName = name ?? `${firstName}-${Date.now().toString(36).slice(-4)}`
    const meta = await runSession({ repos, name: sessionName, config })
    console.log(`✓ session ${meta.id} started`)
    console.log(`  name:      ${meta.name}`)
    for (const r of meta.repos) {
        console.log(`  repo:      ${r.ownerRepo}`)
        console.log(`  branch:    ${r.branch}`)
        console.log(`  clone:     ${r.clonePath}`)
    }
    console.log(`  container: ${meta.containerName}`)
    if (meta.rcEnvironmentUrl) console.log(`  url:       ${meta.rcEnvironmentUrl}`)
}

const runSessionLs = async (argv: string[]): Promise<void> => {
    const json = argv.includes("--json")
    const sessions = await listSessions()
    if (json) {
        process.stdout.write(`${JSON.stringify(sessions, null, 2)}\n`)
        return
    }
    if (sessions.length === 0) {
        console.log("No sessions.")
        return
    }
    for (const s of sessions) {
        const repos = s.repos.map((r) => r.ownerRepo).join(", ")
        console.log(`${s.id}  [${s.state.padEnd(14)}]  ${s.name.padEnd(30)}  ${repos}`)
        if (s.rcEnvironmentUrl) console.log(`        ${s.rcEnvironmentUrl}`)
    }
}

const runSessionPick = async (idOrName: string | null): Promise<void> => {
    if (idOrName) {
        const s = await findSession(idOrName)
        if (!s) throw new Error(`No session matching '${idOrName}'`)
        await attachSession(s.id)
        return
    }

    if (process.stdin.isTTY !== true) {
        // Not a TTY — fall back to ls so scripts don't hang on the picker.
        await runSessionLs([])
        return
    }

    const config = await loadConfig()
    const result = await pickSession(config)
    if (result === null) return
    if (result.kind === "new") {
        const meta = await runSession({ repos: [result.repo], name: result.name, config })
        console.log(`✓ session ${meta.id} started — attaching…`)
        if (meta.rcEnvironmentUrl) console.log(`  ${meta.rcEnvironmentUrl}`)
        await attachSession(meta.id)
        return
    }
    await attachSession(result.row.id)
}

// ----- main -----

const argv = process.argv.slice(2)
const cmd = argv[0]

if (!cmd || cmd === "-h" || cmd === "--help") printHelpAndExit()

try {
    switch (cmd) {
        case "session":
            await runSessionCmd(argv.slice(1))
            break
        case "image-build":
            await runImageBuild()
            break
        case "clean":
            await runClean(argv.slice(1))
            break
        case "doctor": {
            const result = await runDoctor()
            printDoctorReport(result)
            if (!result.ok) process.exit(1)
            break
        }
        case "install-specs":
            await installSpecs()
            break
        default:
            throw new Error(`unknown command: ${cmd}`)
    }
} catch (err) {
    process.stderr.write(`baywatch: ${(err as Error).message}\n`)
    process.exit(1)
}
