import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as vscode from "vscode"

import type { RunEntry } from "./types.js"

// Live-tails an agent log into a single shared output channel. Switching to a different
// run kills the previous tail and starts a new one — keeps memory bounded and the channel
// focused on what the maintainer's actually looking at.

let channel: vscode.OutputChannel | null = null
let activeTail: ChildProcessWithoutNullStreams | null = null
let activeRunId: number | null = null

function ensureChannel(): vscode.OutputChannel {
    if (!channel) channel = vscode.window.createOutputChannel("Baywatch · Run log")
    return channel
}

export function tailRun(run: RunEntry): void {
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

    const child = spawn("tail", ["-n", "+1", "-f", run.logPath])
    activeTail = child
    activeRunId = run.runId

    child.stdout.on("data", (chunk: Buffer) => ch.append(chunk.toString()))
    child.stderr.on("data", (chunk: Buffer) => ch.append(chunk.toString()))
    child.on("close", () => {
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
