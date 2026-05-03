import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

// Resolve the env vars the agent needs inside the sandbox.
// Bun auto-loads `.env` from cwd, so `process.env` already reflects whatever is there.
//
// Anthropic auth: there are two flavours and they behave differently —
//   1. ~/.claude/auth.json (from `claude auth login`)  — full-scope, supports Remote Control
//      (sessions appear at claude.ai/code). Mounted into the sandbox by the agent code.
//   2. CLAUDE_CODE_OAUTH_TOKEN env (from `claude setup-token`) — inference-only, does NOT
//      support Remote Control. Forwarded as a fallback when auth.json isn't available.
// Per the official docs (https://code.claude.com/docs/en/remote-control.md): "tokens
// from setup-token are limited to inference-only and cannot establish Remote Control
// sessions." So we prefer auth.json mounting over env-var fallback.
//
// GitHub auth (optional but expected): `GITHUB_TOKEN` with read-only scopes
// (Contents: read, Issues: read, PRs: read). The agent's `gh` inside the sandbox uses this.
// If not set, gh inside the sandbox is unauthenticated.
export function loadAgentEnv(): Record<string, string> {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    const hasAuthJson = existsSync(hostClaudeAuthPath())
    if (!oauth && !apiKey && !hasAuthJson) {
        throw new Error(
            "No Claude credentials found.\n" +
                "  Recommended (supports Remote Control): claude auth login  → mounts ~/.claude/auth.json into the sandbox\n" +
                "  Fallback (inference-only):             claude setup-token  → CLAUDE_CODE_OAUTH_TOKEN=... in baywatch/.env\n" +
                "  Pay-per-token:                         ANTHROPIC_API_KEY=...                in baywatch/.env"
        )
    }
    const env: Record<string, string> = {}
    if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey
    const ghToken = process.env.GITHUB_TOKEN
    if (ghToken) env.GITHUB_TOKEN = ghToken
    else console.warn("[agent-env] GITHUB_TOKEN not set — `gh` inside the sandbox will be unauthenticated.")
    return env
}

export function hostClaudeAuthPath(): string {
    return path.join(homedir(), ".claude", "auth.json")
}
