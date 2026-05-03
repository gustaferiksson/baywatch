import { createReadStream, existsSync, statSync, unwatchFile, watchFile } from "node:fs"
import * as vscode from "vscode"

import type { RunEntry } from "./types.js"

// Live-tails an agent log into a single shared output channel. Switching to a different
// run kills the previous tail and starts a new one — keeps memory bounded and the
// channel focused on what the maintainer's actually looking at.
//
// Implemented with fs.watchFile + createReadStream (pure Node) rather than spawning
// `tail`, so it works regardless of how VS Code's extension host PATH is configured
// and surfaces every stage in the channel itself.

let channel: vscode.OutputChannel | null = null
let stopFn: (() => void) | null = null
let activeRunId: number | null = null

function ensureChannel(): vscode.OutputChannel {
    if (!channel) channel = vscode.window.createOutputChannel("Baywatch · Run log")
    return channel
}

function tailFileToChannel(filePath: string, ch: vscode.OutputChannel): () => void {
    let position = 0
    try {
        position = statSync(filePath).size
    } catch {
        position = 0
    }

    // Print the file's existing contents up to our starting offset, then watch for growth.
    if (position > 0) {
        const initial = createReadStream(filePath, { encoding: "utf8", end: position - 1 })
        initial.on("data", (chunk) => ch.append(chunk.toString()))
        initial.on("error", (err) => ch.appendLine(`\n[baywatch] initial read error: ${err.message}`))
    }

    const listener = (curr: { size: number }): void => {
        if (curr.size > position) {
            const stream = createReadStream(filePath, {
                encoding: "utf8",
                start: position,
                end: curr.size - 1,
            })
            stream.on("data", (chunk) => ch.append(chunk.toString()))
            stream.on("error", (err) => ch.appendLine(`\n[baywatch] tail read error: ${err.message}`))
            position = curr.size
        } else if (curr.size < position) {
            // File truncated / rotated — reset and replay from byte 0.
            position = 0
            ch.appendLine(`\n[baywatch] log truncated; restarting tail from start`)
            const stream = createReadStream(filePath, { encoding: "utf8" })
            stream.on("data", (chunk) => {
                ch.append(chunk.toString())
                position += Buffer.byteLength(chunk.toString(), "utf8")
            })
        }
    }
    watchFile(filePath, { interval: 500, persistent: false }, listener)
    return () => unwatchFile(filePath, listener)
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

    stopFn = tailFileToChannel(run.logPath, ch)
    activeRunId = run.runId
}

export function stopTail(): void {
    if (stopFn) {
        stopFn()
        stopFn = null
        activeRunId = null
    }
}
