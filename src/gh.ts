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

export async function listAuthoredPRs(): Promise<ThinPR[]> {
    const json = await runGh([
        "search",
        "prs",
        "--author",
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

// Returns process.env with GITHUB_TOKEN/GH_TOKEN scrubbed, so callers spawning gh
// directly (e.g. `gh pr checkout` with stdio: inherit, where runGh's pipe-and-capture
// shape doesn't fit) can use the user's `gh auth login` rather than the read-only
// PAT we ship into the sandbox.
export function hostGhEnv(): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue
        if (k === "GITHUB_TOKEN" || k === "GH_TOKEN") continue
        env[k] = v
    }
    return env
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

// Returns OPEN PRs that GitHub considers linked to this issue via the "Development"
// panel (i.e. the user actively linked them in the UI), regardless of which repo
// they live in. Uses the GraphQL `closedByPullRequestsReferences` field — the same
// thing the Development panel renders.
//
// Only triggered when the user explicitly asks for an issue's bundle (no implicit
// keyword scanning). Returns full PR records ready for the review prompt.
export async function findActivelyLinkedOpenPRs(ownerRepo: string, issueNumber: number): Promise<PR[]> {
    const [owner, repo] = ownerRepo.split("/")
    if (!owner || !repo) throw new Error(`bad owner/repo: ${ownerRepo}`)
    const query = `
        query($owner: String!, $repo: String!, $num: Int!) {
            repository(owner: $owner, name: $repo) {
                issue(number: $num) {
                    closedByPullRequestsReferences(first: 50, includeClosedPrs: false) {
                        nodes {
                            number title body url isDraft updatedAt
                            headRefName headRefOid baseRefName
                            repository { nameWithOwner }
                        }
                    }
                }
            }
        }
    `.trim()
    const json = await runGh([
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `repo=${repo}`,
        "-F",
        `num=${issueNumber}`,
    ])
    const parsed = JSON.parse(json) as {
        data?: {
            repository?: { issue?: { closedByPullRequestsReferences?: { nodes?: PR[] } } }
        }
    }
    const nodes = parsed.data?.repository?.issue?.closedByPullRequestsReferences?.nodes
    if (!nodes) throw new Error(`no linked-PR data returned for ${ownerRepo}#${issueNumber}`)
    return nodes
}

// Returns open PRs in `ownerRepo` whose title or body contains a closing keyword
// referencing the issue (closes/fixes/resolves #N). Used for the issue-discovery
// blocked-by detection (different from actively-linked PRs above).
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
