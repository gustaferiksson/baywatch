import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

const NOTES_DIR = path.join(homedir(), ".baywatch", "notes")

// Notes are per-ref free-form markdown the user writes ahead of a run. Agents read
// them during their run and treat them as additional context (priorities, gotchas,
// links to related work, etc.).

export function noteFilePath(ref: string): string {
    // ref is "owner/repo#num" — flatten to a safe filename
    const safe = ref.replace(/[\\/:#]/g, "__")
    return path.join(NOTES_DIR, `${safe}.md`)
}

export function readNote(ref: string): string | null {
    const p = noteFilePath(ref)
    if (!existsSync(p)) return null
    const content = readFileSync(p, "utf8").trim()
    return content.length > 0 ? content : null
}

export function writeNote(ref: string, content: string): string {
    if (!existsSync(NOTES_DIR)) mkdirSync(NOTES_DIR, { recursive: true })
    const p = noteFilePath(ref)
    writeFileSync(p, content)
    return p
}
