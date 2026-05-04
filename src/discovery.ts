import type { BaywatchConfig } from "./config.ts"
import {
    findActivelyLinkedOpenPRs,
    getIssue,
    getPR,
    type Issue,
    type LinkedPR,
    listAssignedIssues,
    listAssignedPRs,
    listAuthoredPRs,
    listReviewRequestedPRs,
    type PR,
    type ThinPR,
} from "./gh.ts"
import { findRepoPath } from "./prep.ts"
import { getLatestReviewFor } from "./state.ts"

export type DiscoveredIssue = Issue & {
    repoPath: string | null
    linkedOpenPRs: LinkedPR[]
}

import type { ReviewVerdict } from "./reviewVerdict.ts"

export type DiscoveredPR = PR & {
    repoPath: string | null
    reasonForReview: "assigned" | "review-requested" | "own" | "watchlist"
    alreadyReviewedAtThisHead: boolean
    lastReviewedAt: number | null
    lastReviewedHead: string | null
    // Verdict on the last review at the CURRENT head, when one exists.
    // null if never reviewed at current head, or if the verdict couldn't be parsed.
    verdictAtCurrentHead: ReviewVerdict
}

function isBlocked(ownerRepo: string, blocklist: string[]): boolean {
    return blocklist.includes(ownerRepo)
}

export async function discoverIssues(config: BaywatchConfig, extraRefs: string[] = []): Promise<DiscoveredIssue[]> {
    const auto = await listAssignedIssues()
    const seen = new Set<string>()
    const collected: Issue[] = []
    const accept = (i: Issue): void => {
        const key = `${i.repository.nameWithOwner}#${i.number}`
        if (seen.has(key)) return
        if (isBlocked(i.repository.nameWithOwner, config.blocklist)) return
        seen.add(key)
        collected.push(i)
    }

    for (const i of auto) accept(i)

    const parsedRefs: { ownerRepo: string; num: number }[] = []
    for (const entry of extraRefs) {
        const m = entry.match(/^([^/]+\/[^#]+)#(\d+)$/)
        if (!m?.[1] || !m[2]) {
            console.warn(`[discovery] ignoring malformed issue ref: ${entry}`)
            continue
        }
        parsedRefs.push({ ownerRepo: m[1], num: Number.parseInt(m[2], 10) })
    }

    const fetched = await Promise.allSettled(parsedRefs.map((r) => getIssue(r.ownerRepo, r.num)))
    for (let i = 0; i < fetched.length; i++) {
        const r = fetched[i]
        const ref = parsedRefs[i]
        if (!r || !ref) continue
        if (r.status === "fulfilled") accept(r.value)
        else console.warn(`[discovery] failed to fetch ${ref.ownerRepo}#${ref.num}: ${r.reason}`)
    }

    // Concurrent linked-PR check per issue. Uses the GraphQL `closedByPullRequestsReferences`
    // field — same data the GitHub Development panel renders — so PRs the user actively
    // linked via the UI (without "closes #N" body keywords) are picked up. Empty array
    // means nothing linked.
    const linked = await Promise.all(
        collected.map((i) =>
            findActivelyLinkedOpenPRs(i.repository.nameWithOwner, i.number)
                .then((prs): LinkedPR[] => prs.map((pr) => ({ number: pr.number, title: pr.title, url: pr.url })))
                .catch((err: unknown) => {
                    console.warn(
                        `[discovery] linked-PR lookup failed for ${i.repository.nameWithOwner}#${i.number}: ${(err as Error).message}`
                    )
                    return [] as LinkedPR[]
                })
        )
    )
    return collected.map((issue, idx) => ({
        ...issue,
        repoPath: findRepoPath(issue.repository.nameWithOwner, config.cloneRoots),
        linkedOpenPRs: linked[idx] ?? [],
    }))
}

type Candidate = {
    thin: ThinPR
    reason: DiscoveredPR["reasonForReview"]
}

// Fast path for explicit refs: 1 `gh pr view` per ref, no `gh search` queries.
// Use this when the caller knows exactly which PRs they want — saves ~3 search calls
// and (N - refs) view calls compared to `discoverPRs` enriching every assigned /
// review-requested / authored result. Reason is "watchlist" (we don't classify because
// classifying would require the same search queries we're trying to skip).
export async function discoverPRsByRefs(refs: ReadonlyArray<string>, config: BaywatchConfig): Promise<DiscoveredPR[]> {
    const parsed: { ownerRepo: string; num: number; ref: string }[] = []
    for (const ref of refs) {
        const m = ref.match(/^([^/]+\/[^#]+)#(\d+)$/)
        if (!m?.[1] || !m[2]) {
            console.warn(`[discovery] ignoring malformed ref: ${ref}`)
            continue
        }
        if (isBlocked(m[1], config.blocklist)) {
            console.warn(`[discovery] ${ref} is in blocklist — skipping`)
            continue
        }
        parsed.push({ ownerRepo: m[1], num: Number.parseInt(m[2], 10), ref })
    }
    const fetched = await Promise.allSettled(parsed.map((p) => getPR(p.ownerRepo, p.num)))
    const results: DiscoveredPR[] = []
    for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        const r = fetched[i]
        if (!p || !r) continue
        if (r.status !== "fulfilled") {
            console.warn(`[discovery] failed to fetch ${p.ref}: ${r.reason}`)
            continue
        }
        const full = r.value
        const last = getLatestReviewFor(full.repository.nameWithOwner, full.number)
        const reviewedAtThisHead = !!last && last.headSha === full.headRefOid
        results.push({
            ...full,
            repoPath: findRepoPath(full.repository.nameWithOwner, config.cloneRoots),
            reasonForReview: "watchlist",
            alreadyReviewedAtThisHead: reviewedAtThisHead,
            lastReviewedAt: last?.reviewedAt ?? null,
            lastReviewedHead: last?.headSha ?? null,
            verdictAtCurrentHead: reviewedAtThisHead ? (last?.verdict ?? null) : null,
        })
    }
    return results
}

// Fast path for explicit issue refs (mirror of discoverPRsByRefs). Skips
// `gh issue list --assignee` + per-issue linked-PR GraphQL calls.
export async function discoverIssuesByRefs(
    refs: ReadonlyArray<string>,
    config: BaywatchConfig
): Promise<DiscoveredIssue[]> {
    const parsed: { ownerRepo: string; num: number; ref: string }[] = []
    for (const ref of refs) {
        const m = ref.match(/^([^/]+\/[^#]+)#(\d+)$/)
        if (!m?.[1] || !m[2]) {
            console.warn(`[discovery] ignoring malformed ref: ${ref}`)
            continue
        }
        if (isBlocked(m[1], config.blocklist)) {
            console.warn(`[discovery] ${ref} is in blocklist — skipping`)
            continue
        }
        parsed.push({ ownerRepo: m[1], num: Number.parseInt(m[2], 10), ref })
    }
    const fetched = await Promise.allSettled(parsed.map((p) => getIssue(p.ownerRepo, p.num)))
    // Skip the linked-PR GraphQL lookup on the fast path — it's another N API calls.
    // The caller asked for these specific issues; if they need linked-PR data, they can
    // call without --only.
    const results: DiscoveredIssue[] = []
    for (let i = 0; i < parsed.length; i++) {
        const p = parsed[i]
        const r = fetched[i]
        if (!p || !r) continue
        if (r.status !== "fulfilled") {
            console.warn(`[discovery] failed to fetch ${p.ref}: ${r.reason}`)
            continue
        }
        const issue = r.value
        results.push({
            ...issue,
            repoPath: findRepoPath(issue.repository.nameWithOwner, config.cloneRoots),
            linkedOpenPRs: [],
        })
    }
    return results
}

export async function discoverPRs(config: BaywatchConfig, watchlist: string[] = []): Promise<DiscoveredPR[]> {
    const [assigned, reviewRequested, authored] = await Promise.all([
        listAssignedPRs(),
        listReviewRequestedPRs(),
        listAuthoredPRs(),
    ])

    // Dedupe by `owner/repo#num`. First-wins precedence: assigned > review-requested > own.
    const candidates = new Map<string, Candidate>()
    const addCandidate = (thin: ThinPR, reason: Candidate["reason"]): void => {
        const key = `${thin.repository.nameWithOwner}#${thin.number}`
        if (candidates.has(key)) return
        if (isBlocked(thin.repository.nameWithOwner, config.blocklist)) return
        candidates.set(key, { thin, reason })
    }
    for (const pr of assigned) addCandidate(pr, "assigned")
    for (const pr of reviewRequested) addCandidate(pr, "review-requested")
    for (const pr of authored) addCandidate(pr, "own")

    // One-shot watchlist refs from the CLI: "owner/repo#123"
    for (const entry of watchlist) {
        const m = entry.match(/^([^/]+\/[^#]+)#(\d+)$/)
        if (!m?.[1] || !m[2]) {
            console.warn(`[discovery] ignoring malformed watchlist ref: ${entry}`)
            continue
        }
        const ownerRepo = m[1]
        const num = Number.parseInt(m[2], 10)
        const key = `${ownerRepo}#${num}`
        if (candidates.has(key)) continue
        if (isBlocked(ownerRepo, config.blocklist)) continue
        candidates.set(key, {
            thin: {
                number: num,
                title: "(watchlist)",
                body: "",
                url: "",
                repository: { nameWithOwner: ownerRepo },
                isDraft: false,
                updatedAt: "",
            },
            reason: "watchlist",
        })
    }

    // Enrich every candidate with head sha + ref names via parallel `gh pr view`.
    const entries = [...candidates.entries()]
    const enriched = await Promise.allSettled(
        entries.map(([_key, c]) => getPR(c.thin.repository.nameWithOwner, c.thin.number))
    )

    const results: DiscoveredPR[] = []
    for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]
        const result = enriched[i]
        if (!entry || !result) continue
        const [, candidate] = entry
        if (result.status !== "fulfilled") {
            console.warn(
                `[discovery] failed to fetch ${candidate.thin.repository.nameWithOwner}#${candidate.thin.number}: ${result.reason}`
            )
            continue
        }
        const full = result.value
        const last = getLatestReviewFor(full.repository.nameWithOwner, full.number)
        const reviewedAtThisHead = !!last && last.headSha === full.headRefOid
        results.push({
            ...full,
            repoPath: findRepoPath(full.repository.nameWithOwner, config.cloneRoots),
            reasonForReview: candidate.reason,
            alreadyReviewedAtThisHead: reviewedAtThisHead,
            lastReviewedAt: last?.reviewedAt ?? null,
            lastReviewedHead: last?.headSha ?? null,
            verdictAtCurrentHead: reviewedAtThisHead ? (last?.verdict ?? null) : null,
        })
    }
    return results
}
