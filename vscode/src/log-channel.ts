import { type ChildProcess, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import * as vscode from "vscode"

import type { RunEntry } from "./types.js"

// Live-tails an agent log into a single shared output channel. Switching to a different
// run kills the previous tail and starts a new one — keeps memory bounded and the channel
// focused on what the maintainer's actually looking at.

let channel: vscode.OutputChannel | null = null
let activeTail: ChildProcess | null = null
let activeRunId: number | null = null

function ensureChannel(): vscode.OutputChannel {
    if (!channel) channel = vscode.window.createOutputChannel("Baywatch · Run log")
    return channel
}

export function tailRun(run: RunEntry): void {
    console.log(`[baywatch] tailRun #${run.runId} logPath=${run.logPath ?? "(none)"}`)
    if (!run.logPath) {
        void vscode.window.showInformationMessage("This run has no log file yet.")
        return
    }
    const ch = ensureChannel()
    if (activeRunId !== run.runId) stopTail()

    ch.clear()
    ch.appendLine(`# baywatch run #${run.runId} — ${run.ownerRepo} ${run.target}`)
    ch.appendLine(`# ${run.logPath}`)
    ch.appendLine("")
    ch.show(true)

    if (!existsSync(run.logPath)) {
        ch.appendLine(`(log file not on disk yet — run may still be starting up)`)
        ch.appendLine(`(retrying in 2s…)`)
        setTimeout(() => tailRun(run), 2000)
        return
    }

    const child = spawn("tail", ["-n", "+1", "-f", run.logPath])
    activeTail = child
    activeRunId = run.runId

    child.stdout?.on("data", (chunk: Buffer) => ch.append(chunk.toString()))
    child.stderr?.on("data", (chunk: Buffer) => ch.append(chunk.toString()))
    child.on("error", (err) => {
        ch.appendLine(`\n[baywatch] tail error: ${err.message}`)
        if (activeTail === child) {
            activeTail = null
            activeRunId = null
        }
    })
    child.on("close", (code) => {
        if (code !== 0 && code !== null) ch.appendLine(`\n[baywatch] tail exited (code ${code})`)
        if (activeTail === child) {
            activeTail = null
            activeRunId = null
        }
    })
}

export function stopTail(): void {
    if (activeTail) {
        activeTail.kill()
        activeTail = null
        activeRunId = null
    }
}
