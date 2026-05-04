import path from "node:path"

import { BAYWATCH_ROOT } from "./config.ts"

const SETTINGS_HOST_PATH = path.join(BAYWATCH_ROOT, ".claude", "settings.json")
const SETTINGS_SANDBOX_PATH = "/home/agent/.claude/settings.json"

type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean }

// Standard mounts for every spawned agent. Currently just the project settings file.
//
// Why no auth mount: claude-code on Linux reads OAuth credentials from the OS keyring
// (libsecret), not from `~/.claude/auth.json`. The bare Debian container has no keyring
// service, so even mounting a copy of the host's auth.json (or extracting from macOS
// Keychain) does nothing — `claude auth status` reports `loggedIn: false`. Remote Control
// would require installing libsecret + running gnome-keyring-daemon + pre-populating the
// secret inside the container; not done here. Spawned agents authenticate via
// CLAUDE_CODE_OAUTH_TOKEN (inference-only) instead, so they don't appear at claude.ai/code.
export async function defaultAgentMounts(): Promise<Mount[]> {
    return [{ hostPath: SETTINGS_HOST_PATH, sandboxPath: SETTINGS_SANDBOX_PATH, readonly: true }]
}
