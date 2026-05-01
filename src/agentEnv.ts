// Resolve the env vars the agent needs inside the sandbox.
// Bun auto-loads `.env` from cwd, so `process.env` already reflects whatever is there.
//
// Anthropic auth: prefer `CLAUDE_CODE_OAUTH_TOKEN` (subscription, set via `claude setup-token`)
// over `ANTHROPIC_API_KEY` (pay-per-token). If both are set, both are forwarded.
//
// GitHub auth (optional but expected): `GITHUB_TOKEN` with read-only scopes
// (Contents: read, Issues: read, PRs: read). The agent's `gh` inside the sandbox uses this.
// If not set, gh inside the sandbox is unauthenticated and read calls fail — the agent can
// still work from the issue/PR data already injected into the prompt.
export function loadAgentEnv(): Record<string, string> {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!oauth && !apiKey) {
        throw new Error(
            "No Claude credentials found in env.\n" +
                "  Subscription auth (recommended):  claude setup-token  →  CLAUDE_CODE_OAUTH_TOKEN=... in baywatch/.env\n" +
                "  API auth (pay-per-token):         ANTHROPIC_API_KEY=...               in baywatch/.env"
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
