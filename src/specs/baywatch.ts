/// <reference types="@withfig/autocomplete-types" />

const dryRunOption: Fig.Option = {
    name: "--dry-run",
    description: "Show what would happen without prepping or running",
}

const onlyOption: Fig.Option = {
    name: "--only",
    description: "Run only the explicit REFs; skip auto-discovery",
}

const limitOption: Fig.Option = {
    name: "--limit",
    description: "Max items to process",
    args: { name: "n", suggestions: ["1", "3", "5", "10"] },
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
                    args: { name: "ref", description: "owner/repo#num", isOptional: true, isVariadic: true },
                },
                {
                    name: "prs",
                    description: "PRs assigned + review-requested (+ ad-hoc refs)",
                    args: { name: "ref", description: "owner/repo#num", isOptional: true, isVariadic: true },
                },
            ],
        },
        {
            name: "dev",
            description: "Run the dev agent against discovered issues (+ ad-hoc refs)",
            options: [dryRunOption, onlyOption, limitOption],
            args: { name: "ref", description: "owner/repo#num", isOptional: true, isVariadic: true },
        },
        {
            name: "review",
            description: "Run the review agent against discovered PRs (+ ad-hoc refs)",
            options: [dryRunOption, onlyOption, limitOption],
            args: { name: "ref", description: "owner/repo#num", isOptional: true, isVariadic: true },
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
            name: "install-specs",
            description: "Build & install this Fig autocomplete spec to ~/.fig/autocomplete/build",
        },
    ],
    options: [{ name: ["--help", "-h"], description: "Show help" }],
}

export default completionSpec
