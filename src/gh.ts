// Run `gh` on the host with GITHUB_TOKEN / GH_TOKEN scrubbed so it falls back to
// the user's `gh auth login` credentials. We deliberately keep those env vars in
// process.env (so loadAgentEnv can forward them into the sandbox), but they should
// not constrain host-side gh calls — the user's interactive auth typically has
// broader scope than the fine-grained PAT we ship into the agent.
async function runGh(args: string[]): Promise<string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue
        if (k === "GITHUB_TOKEN" || k === "GH_TOKEN") continue
        env[k] = v
    }
    const proc = Bun.spawn(["gh", ...args], { env, stdout: "pipe", stderr: "pipe" })
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const exitCode = await proc.exited
    if (exitCode !== 0) {
        throw new Error(`gh ${args.slice(0, 3).join(" ")} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`)
    }
    return stdout
}

export type Issue = {
    number: number
    title: string
    body: string
    url: string
    repository: { nameWithOwner: string }
    labels?: { name: string }[]
    updatedAt: string
}

// What `gh search prs` can give us. Notably no head sha — we have to fetch that separately.
export type ThinPR = {
    number: number
    title: string
    body: string
    url: string
    repository: { nameWithOwner: string }
    isDraft: boolean
    updatedAt: string
}

export type PR = ThinPR & {
    headRefName: string
    headRefOid: string
    baseRefName: string
}

const ISSUE_FIELDS = "number,title,body,url,repository,labels,updatedAt"
const SEARCH_PR_FIELDS = "number,title,body,url,repository,isDraft,updatedAt"
const FULL_PR_FIELDS = "number,title,body,url,headRefName,headRefOid,baseRefName,isDraft,updatedAt"

export async function listAssignedIssues(): Promise<Issue[]> {
    const json = await runGh([
        "search",
        "issues",
        "--assignee",
        "@me",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        ISSUE_FIELDS,
    ])
    return JSON.parse(json) as Issue[]
}

export async function listAssignedPRs(): Promise<ThinPR[]> {
    const json = await runGh([
        "search",
        "prs",
        "--assignee",
        "@me",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        SEARCH_PR_FIELDS,
    ])
    return JSON.parse(json) as ThinPR[]
}

export async function listReviewRequestedPRs(): Promise<ThinPR[]> {
    const json = await runGh([
        "search",
        "prs",
        "--review-requested",
        "@me",
        "--state",
        "open",
        "--limit",
        "100",
        "--json",
        SEARCH_PR_FIELDS,
    ])
    return JSON.parse(json) as ThinPR[]
}

export async function getPR(ownerRepo: string, num: number): Promise<PR> {
    const json = await runGh(["pr", "view", String(num), "--repo", ownerRepo, "--json", FULL_PR_FIELDS])
    const parsed = JSON.parse(json) as Omit<PR, "repository">
    return { ...parsed, repository: { nameWithOwner: ownerRepo } }
}

const ISSUE_VIEW_FIELDS = "number,title,body,url,labels,updatedAt"

export async function getIssue(ownerRepo: string, num: number): Promise<Issue> {
    const json = await runGh(["issue", "view", String(num), "--repo", ownerRepo, "--json", ISSUE_VIEW_FIELDS])
    const parsed = JSON.parse(json) as Omit<Issue, "repository">
    return { ...parsed, repository: { nameWithOwner: ownerRepo } }
}

export type LinkedPR = { number: number; title: string; url: string }

// Returns open PRs in `ownerRepo` whose title or body contains a closing keyword
// referencing the issue (closes/fixes/resolves #N). gh 2.69 doesn't expose
// `closedByPullRequestsReferences`, so we search and post-filter.
export async function findLinkedOpenPRs(ownerRepo: string, issueNumber: number): Promise<LinkedPR[]> {
    const search = `#${issueNumber} in:body,title`
    const json = await runGh([
        "pr",
        "list",
        "--repo",
        ownerRepo,
        "--state",
        "open",
        "--search",
        search,
        "--json",
        "number,title,url,body",
        "--limit",
        "50",
    ])
    const list = JSON.parse(json) as (LinkedPR & { body: string })[]
    const closing = new RegExp(String.raw`(?:closes|fixes|resolves)\s+#${issueNumber}\b`, "i")
    return list
        .filter((pr) => closing.test(pr.body ?? "") || closing.test(pr.title))
        .map(({ number, title, url }) => ({ number, title, url }))
}
