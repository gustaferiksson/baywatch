/// <reference types="@withfig/autocomplete-types" />

const dryRunOption: Fig.Option = {
    name: "--dry-run",
    description: "Show what would happen without prepping or running",
}

const onlyOption: Fig.Option = {
    name: "--only",
    description: "Run only the explicit REFs; skip auto-discovery",
}

const autoOption: Fig.Option = {
    name: "--auto",
    description: "Skip the interactive picker; take first --limit from discovery",
}

const limitOption: Fig.Option = {
    name: "--limit",
    description: "Max items to process",
    args: { name: "n", suggestions: ["1", "3", "5", "10"] },
}

const jsonOption: Fig.Option = {
    name: "--json",
    description: "Emit JSON (used by tooling and Fig generators)",
}

const issueRefArg: Fig.Arg = {
    name: "issue-ref",
    description: "owner/repo#num (Tab to pick from your assigned issues)",
    isOptional: true,
    isVariadic: true,
    generators: {
        script: ["sh", "-c", "baywatch list issues --json 2>/dev/null"],
        cache: { ttl: 60_000 },
        postProcess: (out: string) => {
            try {
                const list = JSON.parse(out) as Array<{
                    ref: string
                    title: string
                    blockedByPRs: number[]
                    hasClone: boolean
                }>
                return list.map((i) => ({
                    name: i.ref,
                    description: `${i.title}${i.blockedByPRs.length > 0 ? `  [blocked by PR #${i.blockedByPRs[0]}]` : ""}${i.hasClone ? "" : "  [no local clone]"}`,
                    priority: i.hasClone && i.blockedByPRs.length === 0 ? 100 : 60,
                }))
            } catch {
                return []
            }
        },
    },
}

const prRefArg: Fig.Arg = {
    name: "pr-ref",
    description: "owner/repo#num (Tab to pick from your discoverable PRs)",
    isOptional: true,
    isVariadic: true,
    generators: {
        script: ["sh", "-c", "baywatch list prs --json 2>/dev/null"],
        cache: { ttl: 60_000 },
        postProcess: (out: string) => {
            try {
                const list = JSON.parse(out) as Array<{
                    ref: string
                    title: string
                    reasonForReview: string
                    alreadyReviewedAtThisHead: boolean
                    hasClone: boolean
                }>
                return list.map((p) => ({
                    name: p.ref,
                    description: `${p.title}  [${p.reasonForReview}]${p.alreadyReviewedAtThisHead ? "  [reviewed-at-head]" : ""}${p.hasClone ? "" : "  [no local clone]"}`,
                    priority: p.hasClone && !p.alreadyReviewedAtThisHead ? 100 : 60,
                }))
            } catch {
                return []
            }
        },
    },
}

const completionSpec: Fig.Spec = {
    name: "baywatch",
    description: "Personal agent orchestrator for solving GH issues and reviewing PRs locally",
    subcommands: [
        {
            name: "list",
            description: "Show what each agent would pick up",
            subcommands: [
                {
                    name: "issues",
                    description: "Issues assigned to me (+ ad-hoc refs)",
                    options: [jsonOption],
                    args: issueRefArg,
                },
                {
                    name: "prs",
                    description: "PRs assigned + review-requested (+ ad-hoc refs)",
                    options: [jsonOption],
                    args: prRefArg,
                },
            ],
        },
        {
            name: "dev",
            description: "Run the dev agent against discovered issues (+ ad-hoc refs)",
            options: [dryRunOption, onlyOption, autoOption, limitOption],
            args: issueRefArg,
        },
        {
            name: "review",
            description: "Run the review agent against discovered PRs (+ ad-hoc refs)",
            options: [
                dryRunOption,
                onlyOption,
                autoOption,
                limitOption,
                {
                    name: "--force",
                    description: "Re-run even if already reviewed at the current head SHA",
                },
                {
                    name: "--bundle",
                    description: "Review multiple PRs together as one cross-PR review (use with REFs)",
                },
                {
                    name: "--for-issue",
                    description: "Review every PR actively linked to this issue via GitHub's Development panel",
                    args: { name: "issue-ref", description: "owner/repo#num" },
                },
            ],
            args: prRefArg,
        },
        {
            name: "logs",
            description: "Recent agent run logs",
            args: {
                name: "run-id",
                description: "Show or tail a specific run (numeric id from `baywatch logs`)",
                isOptional: true,
                generators: {
                    script: ["sh", "-c", "baywatch logs --json --limit 50 2>/dev/null"],
                    cache: { ttl: 5_000 },
                    postProcess: (out: string) => {
                        try {
                            const runs = JSON.parse(out) as Array<{
                                runId: number
                                kind: string
                                status: string
                                ownerRepo: string
                                target: string
                            }>
                            return runs.map((r) => ({
                                name: String(r.runId),
                                description: `[${r.kind}] [${r.status}] ${r.ownerRepo} ${r.target}`,
                                priority: r.status === "running" ? 100 : 80,
                            }))
                        } catch {
                            return []
                        }
                    },
                },
            },
            options: [
                { name: ["--follow", "-f"], description: "Tail the log (latest if no id, otherwise the given run)" },
                { name: "--running", description: "Filter to in-flight runs" },
                { name: "--json", description: "Emit JSON (used by tooling and Fig completions)" },
                {
                    name: "--limit",
                    description: "How many recent logs to list",
                    args: { name: "n", suggestions: ["5", "10", "25"] },
                },
            ],
        },
        {
            name: "image-build",
            description: "Rebuild the baywatch-agent podman image from baywatch's Containerfile",
        },
        {
            name: "doctor",
            description: "Pre-flight check: gh auth, podman machine, image, env tokens, config",
        },
        {
            name: "retry",
            description: "Re-dispatch the same kind/target as a previous run",
            args: { name: "run-id", description: "Numeric run id from `baywatch logs`", isOptional: false },
        },
        {
            name: "stop",
            description:
                "Cancel running runs (kills baywatch-agent containers; with id, marks just that run, otherwise all)",
            args: {
                name: "run-id",
                description: "Numeric run id from `baywatch logs --running` (omit to cancel all running runs)",
                isOptional: true,
                generators: {
                    script: ["sh", "-c", "baywatch logs --running --json --limit 25 2>/dev/null"],
                    cache: { ttl: 2_000 },
                    postProcess: (out: string) => {
                        try {
                            const runs = JSON.parse(out) as Array<{
                                runId: number
                                kind: string
                                ownerRepo: string
                                target: string
                            }>
                            return runs.map((r) => ({
                                name: String(r.runId),
                                description: `[${r.kind}] ${r.ownerRepo} ${r.target}`,
                                priority: 100,
                            }))
                        } catch {
                            return []
                        }
                    },
                },
            },
        },
        {
            name: "open",
            description: "Open the most relevant artifact for a run (review .md or agent clone)",
            args: { name: "run-id", description: "Numeric run id from `baywatch logs`", isOptional: false },
        },
        {
            name: "notes",
            description: "Free-form notes injected into the agent prompt for a REF",
            args: { name: "ref", description: "owner/repo#num", isOptional: false },
            options: [
                { name: "--path", description: "Print the file path (default; pipe to your editor)" },
                { name: "--print", description: "Print the current note contents to stdout" },
                { name: "--write", description: "Write stdin to the note file (overwrites)" },
            ],
        },
        {
            name: "clean",
            description: "Cleanup commands for baywatch's local state",
            subcommands: [
                {
                    name: "clones",
                    description: "Remove ~/.baywatch/clones/ entries older than --older-than (skips in-flight)",
                    options: [
                        {
                            name: "--older-than",
                            description: "Age threshold (e.g. 14d, 24h, 30m, 60s)",
                            args: { name: "duration", suggestions: ["7d", "14d", "30d", "24h"] },
                        },
                        { name: "--dry-run", description: "List what would be removed without removing" },
                    ],
                },
            ],
        },
        {
            name: "install-specs",
            description: "Build & install this Fig autocomplete spec to ~/.fig/autocomplete/build",
        },
    ],
    options: [{ name: ["--help", "-h"], description: "Show help" }],
}

export default completionSpec
