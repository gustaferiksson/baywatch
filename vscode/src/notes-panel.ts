import * as vscode from "vscode"

import { readNote, writeNote } from "./cli.js"

// A single shared webview panel that edits the note for whichever ref the maintainer
// last asked for. Notes are persisted to ~/.baywatch/notes/<flat-ref>.md via the
// baywatch CLI; the agent prompts pick them up on the next run as additional context.

let panel: vscode.WebviewPanel | null = null
let activeRef: string | null = null

export async function openNotesPanel(ref: string, context: vscode.ExtensionContext): Promise<void> {
    activeRef = ref
    const initial = await readNote(ref)

    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside)
        panel.title = `Baywatch notes · ${ref}`
        panel.webview.html = htmlFor(ref, initial)
        return
    }

    panel = vscode.window.createWebviewPanel("baywatch.notes", `Baywatch notes · ${ref}`, vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true,
    })
    panel.webview.html = htmlFor(ref, initial)

    const sub = panel.webview.onDidReceiveMessage(async (msg: { type: string; content?: string }) => {
        if (msg.type === "save" && activeRef && typeof msg.content === "string") {
            try {
                await writeNote(activeRef, msg.content)
                panel?.webview.postMessage({ type: "saved" })
                void vscode.window.setStatusBarMessage(`Baywatch: saved notes for ${activeRef}`, 3000)
            } catch (err) {
                void vscode.window.showErrorMessage(`Save failed: ${(err as Error).message}`)
            }
        }
    })
    context.subscriptions.push(sub)

    panel.onDidDispose(() => {
        panel = null
        activeRef = null
    })
}

function htmlFor(ref: string, initial: string): string {
    const escaped = initial.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    return /* html */ `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 16px; }
    h1 { font-size: 1rem; margin: 0 0 8px 0; }
    .hint { color: var(--vscode-descriptionForeground); font-size: 0.85rem; margin-bottom: 12px; }
    textarea { width: 100%; height: calc(100vh - 160px); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 8px; resize: vertical; }
    .row { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
    button { font-family: inherit; padding: 6px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 2px; cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .saved { color: var(--vscode-charts-green); display: none; }
    .saved.shown { display: inline; }
</style>
</head>
<body>
<h1>Notes for <code>${ref}</code></h1>
<div class="hint">These notes are injected into the agent's prompt on the next baywatch dev/review run for this ref. Use them to flag priorities, gotchas, things to ignore, or context the issue/PR body didn't capture.</div>
<textarea id="content" placeholder="Notes for the agent (markdown ok)…">${escaped}</textarea>
<div class="row">
    <button id="save">Save</button>
    <span class="saved" id="saved">✓ saved</span>
</div>
<script>
const vscode = acquireVsCodeApi();
const textarea = document.getElementById("content");
const saved = document.getElementById("saved");
document.getElementById("save").addEventListener("click", () => {
    vscode.postMessage({ type: "save", content: textarea.value });
});
window.addEventListener("message", (e) => {
    if (e.data?.type === "saved") {
        saved.classList.add("shown");
        setTimeout(() => saved.classList.remove("shown"), 1500);
    }
});
// Cmd/Ctrl-S to save
textarea.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        vscode.postMessage({ type: "save", content: textarea.value });
    }
});
</script>
</body>
</html>`
}
