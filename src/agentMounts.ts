import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { $ } from "bun"

import { BAYWATCH_ROOT } from "./config.ts"

const SETTINGS_HOST_PATH = path.join(BAYWATCH_ROOT, ".claude", "settings.json")
const SETTINGS_SANDBOX_PATH = "/home/agent/.claude/settings.json"
const AUTH_SANDBOX_PATH = "/home/agent/.claude/auth.json"

type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean }

export type SandboxMounts = {
    mounts: Mount[]
    // Called after sandcastle.run completes or fails. Removes any temporary files
    // (e.g. the materialised auth.json on macOS).
    cleanup: () => Promise<void>
}

// Standard mounts for every spawned agent. Materialises the Claude Code credential
// (from the platform's storage — macOS Keychain, Linux file) into a temp file the
// container can bind-mount, so the spawned agent registers with claude.ai/code's
// Remote Control rather than just inference-only.
export async function defaultAgentMounts(): Promise<SandboxMounts> {
    const mounts: Mount[] = [{ hostPath: SETTINGS_HOST_PATH, sandboxPath: SETTINGS_SANDBOX_PATH, readonly: true }]
    const auth = await materializeAuthFile()
    if (auth) mounts.push({ hostPath: auth.path, sandboxPath: AUTH_SANDBOX_PATH, readonly: true })
    return { mounts, cleanup: auth?.cleanup ?? noop }
}

const noop = async (): Promise<void> => undefined

async function materializeAuthFile(): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
    if (process.platform === "darwin") {
        return materializeFromKeychain()
    }
    const linuxFile = path.join(homedir(), ".claude", "auth.json")
    if (existsSync(linuxFile)) return { path: linuxFile, cleanup: noop }
    return null
}

async function materializeFromKeychain(): Promise<{ path: string; cleanup: () => Promise<void> } | null> {
    try {
        // The credential is stored as a generic password under "Claude Code-credentials".
        // -w prints the password (the credential JSON blob) to stdout.
        const blob = (await $`security find-generic-password -s "Claude Code-credentials" -w`.text()).trim()
        if (!blob) return null

        const dir = path.join(tmpdir(), "baywatch-auth")
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
        const file = path.join(dir, `auth-${process.pid}-${Date.now()}.json`)
        writeFileSync(file, blob, { mode: 0o600 })

        return {
            path: file,
            cleanup: async () => {
                try {
                    await unlink(file)
                } catch {
                    // best-effort cleanup; ok if already gone or unwriteable
                }
            },
        }
    } catch {
        // keychain not available, password not found, or user denied access
        return null
    }
}
