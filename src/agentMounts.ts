import { existsSync } from "node:fs"
import path from "node:path"

import { hostClaudeAuthPath } from "./agentEnv.ts"
import { BAYWATCH_ROOT } from "./config.ts"

const SETTINGS_HOST_PATH = path.join(BAYWATCH_ROOT, ".claude", "settings.json")
const SETTINGS_SANDBOX_PATH = "/home/agent/.claude/settings.json"
const AUTH_SANDBOX_PATH = "/home/agent/.claude/auth.json"

type Mount = { hostPath: string; sandboxPath: string; readonly?: boolean }

// Mounts every spawned agent gets:
//   - baywatch's settings.json (deny list + model + remoteControlAtStartup)
//   - the host user's ~/.claude/auth.json (when present) so the agent inherits their
//     interactive `claude auth login` session and can register with claude.ai/code's
//     Remote Control. Without this, CLAUDE_CODE_OAUTH_TOKEN authenticates but the
//     session never appears in the user's claude.ai/code list (token is inference-only).
export function defaultAgentMounts(): Mount[] {
    const mounts: Mount[] = [{ hostPath: SETTINGS_HOST_PATH, sandboxPath: SETTINGS_SANDBOX_PATH, readonly: true }]
    const auth = hostClaudeAuthPath()
    if (existsSync(auth)) {
        mounts.push({ hostPath: auth, sandboxPath: AUTH_SANDBOX_PATH, readonly: true })
    }
    return mounts
}
