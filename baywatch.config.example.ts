import type { BaywatchConfig } from "./src/config.ts"

// Copy this file to `baywatch.config.ts` and adjust to your local layout.
// `baywatch.config.ts` is gitignored — your real paths and overrides stay on your machine.

const config: BaywatchConfig = {
    // Where your local clones live. Discovery pairs each `owner/repo` it finds with a directory
    // on disk by checking these roots in order. First hit wins.
    cloneRoots: [
        // "/Users/you/Repos/personal",
        // "/Users/you/Repos/work",
    ],

    // Repos the dev agent should never touch, even if you're assigned issues there.
    blocklist: [
        // "owner/repo",
    ],

    // Default Claude model passed into sandcastle's claudeCode() agent.
    // The `[1m]` suffix selects the 1M token context window.
    agent: {
        model: "claude-opus-4-7[1m]",
    },

    // Per-repo overrides (e.g. custom default branch, custom install command).
    repoOverrides: {
        // "owner/repo": { defaultBranch: "develop", installCmd: "pnpm install --frozen-lockfile" },
    },
}

export default config
