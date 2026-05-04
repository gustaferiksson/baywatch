// Resolve the env vars the agent needs inside the sandbox.
// Bun auto-loads `.env` from cwd, so `process.env` already reflects whatever is there.
//
// Anthropic auth inside the container:
//   - `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) — inference-only. Spawned
//     agents authenticate but DON'T appear at claude.ai/code (no Remote Control session).
//   - `ANTHROPIC_API_KEY` — pay-per-token, also inference-only.
//
// Remote Control (sessions visible at claude.ai/code) requires the full OAuth from
// `claude auth login`, which on Linux is stored in libsecret/gnome-keyring. The bare
// Debian container has no keyring service, so we can't currently provide it. If you want
// Remote Control inside the sandbox, the container needs libsecret + gnome-keyring-daemon
// + pre-populated secret — open follow-up work, not implemented today.
//
// GitHub auth (optional but expected): `GITHUB_TOKEN` with read-only scopes
// (Contents: read, Issues: read, PRs: read). The agent's `gh` inside the sandbox uses this.
// If not set, gh inside the sandbox is unauthenticated.
export function loadAgentEnv(): Record<string, string> {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!oauth && !apiKey) {
        throw new Error(
            "No Claude credentials found in env.\n" +
                "  Inference-only (recommended for now): claude setup-token  → CLAUDE_CODE_OAUTH_TOKEN=... in baywatch/.env\n" +
                "  Pay-per-token:                        ANTHROPIC_API_KEY=...                in baywatch/.env\n" +
                "  Note: Remote Control (sessions at claude.ai/code) is NOT supported in the current container — needs libsecret."
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
