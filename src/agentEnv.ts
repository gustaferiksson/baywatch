// Resolve the env vars the agent needs inside the sandbox to authenticate with Anthropic.
// Bun auto-loads `.env` from cwd, so `process.env` already reflects whatever is there.
//
// Prefer `CLAUDE_CODE_OAUTH_TOKEN` (subscription-based, set via `claude setup-token`) over
// `ANTHROPIC_API_KEY` (pay-per-token). If both are set, both are forwarded — Claude Code
// resolves which to use.
export function loadAgentAuthEnv(): Record<string, string> {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!oauth && !apiKey) {
        throw new Error(
            "No Claude credentials found in env.\n" +
                "  Subscription auth (recommended):  claude setup-token  →  CLAUDE_CODE_OAUTH_TOKEN=... in baywatch/.env\n" +
                "  API auth (pay-per-token):        ANTHROPIC_API_KEY=...                in baywatch/.env"
        )
    }
    const env: Record<string, string> = {}
    if (oauth) env.CLAUDE_CODE_OAUTH_TOKEN = oauth
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey
    return env
}
