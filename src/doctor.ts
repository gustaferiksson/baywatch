import { existsSync } from "node:fs"
import path from "node:path"
import { $ } from "bun"

import { BAYWATCH_ROOT } from "./config.ts"

type Status = "ok" | "warn" | "fail"

type CheckResult = {
    name: string
    status: Status
    detail: string
    hint?: string
}

async function check(name: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
    try {
        return await run()
    } catch (err) {
        return { name, status: "fail", detail: `unexpected error: ${(err as Error).message}` }
    }
}

async function checkGh(): Promise<CheckResult> {
    return check("gh CLI authenticated", async () => {
        const proc = Bun.spawn(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" })
        const code = await proc.exited
        if (code !== 0) {
            const err = await new Response(proc.stderr).text()
            return {
                name: "gh CLI authenticated",
                status: "fail",
                detail: err.split("\n")[0] ?? "exit non-zero",
                hint: "run `gh auth login`",
            }
        }
        return { name: "gh CLI authenticated", status: "ok", detail: "logged in" }
    })
}

async function checkPodmanMachine(): Promise<CheckResult> {
    return check("podman machine running", async () => {
        const out = await $`podman machine list --format json`.text()
        const machines = JSON.parse(out) as Array<{ Name: string; Running: boolean }>
        const running = machines.find((m) => m.Running)
        if (!running) {
            return {
                name: "podman machine running",
                status: "fail",
                detail: machines.length === 0 ? "no podman machines configured" : "no machine is currently running",
                hint:
                    machines.length === 0
                        ? "run `podman machine init && podman machine start`"
                        : "run `podman machine start`",
            }
        }
        return { name: "podman machine running", status: "ok", detail: running.Name }
    })
}

async function checkImage(): Promise<CheckResult> {
    return check("baywatch-agent podman image", async () => {
        const out = await $`podman image exists baywatch-agent`.nothrow().quiet()
        if (out.exitCode !== 0) {
            return {
                name: "baywatch-agent podman image",
                status: "fail",
                detail: "image not built",
                hint: "run `baywatch image-build`",
            }
        }
        return { name: "baywatch-agent podman image", status: "ok", detail: "present" }
    })
}

function checkEnvTokens(): CheckResult {
    const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    const apiKey = process.env.ANTHROPIC_API_KEY
    const ghToken = process.env.GITHUB_TOKEN
    if (!oauth && !apiKey) {
        return {
            name: "Claude credentials in env",
            status: "fail",
            detail: "neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY set",
            hint: "run `claude setup-token` and put it in baywatch/.env",
        }
    }
    const claudeNote = oauth ? "CLAUDE_CODE_OAUTH_TOKEN set" : "ANTHROPIC_API_KEY set"
    if (!ghToken) {
        return {
            name: "Claude credentials in env",
            status: "warn",
            detail: `${claudeNote}; GITHUB_TOKEN unset`,
            hint: "agent's `gh` inside the sandbox will be unauthenticated — set GITHUB_TOKEN with read-only scopes to fix",
        }
    }
    return { name: "Claude credentials in env", status: "ok", detail: `${claudeNote}; GITHUB_TOKEN set` }
}

function checkConfig(): CheckResult {
    const cfg = path.join(BAYWATCH_ROOT, "baywatch.config.ts")
    if (!existsSync(cfg)) {
        return {
            name: "baywatch.config.ts present",
            status: "fail",
            detail: `missing at ${cfg}`,
            hint: `cp ${path.join(BAYWATCH_ROOT, "baywatch.config.example.ts")} ${cfg}`,
        }
    }
    return { name: "baywatch.config.ts present", status: "ok", detail: cfg }
}

export async function runDoctor(): Promise<{ checks: CheckResult[]; ok: boolean }> {
    const checks = await Promise.all([
        checkGh(),
        checkPodmanMachine(),
        checkImage(),
        Promise.resolve(checkEnvTokens()),
        Promise.resolve(checkConfig()),
    ])
    const ok = checks.every((c) => c.status !== "fail")
    return { checks, ok }
}

export function printDoctorReport(result: { checks: CheckResult[]; ok: boolean }): void {
    const icon = (s: Status): string => (s === "ok" ? "✓" : s === "warn" ? "!" : "✗")
    for (const c of result.checks) {
        console.log(`${icon(c.status)} ${c.name.padEnd(35)} ${c.detail}`)
        if (c.hint) console.log(`  → ${c.hint}`)
    }
    console.log()
    console.log(
        result.ok ? "✓ All checks passed." : "✗ Some checks failed — fix the items above before running agents."
    )
}
