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
            options: [
                { name: ["--follow", "-f"], description: "Tail the most recent log" },
                { name: "--running", description: "Filter to in-flight runs" },
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
