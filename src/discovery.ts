import type { BaywatchConfig } from "./config.ts"
import {
    getIssue,
    getPR,
    type Issue,
    listAssignedIssues,
    listAssignedPRs,
    listReviewRequestedPRs,
    type PR,
    type ThinPR,
} from "./gh.ts"
import { findRepoPath } from "./prep.ts"
import { getLatestReviewFor } from "./state.ts"

export type DiscoveredIssue = Issue & { repoPath: string | null }

export type DiscoveredPR = PR & {
    repoPath: string | null
    reasonForReview: "assigned" | "review-requested" | "watchlist"
    alreadyReviewedAtThisHead: boolean
}

function isBlocked(ownerRepo: string, blocklist: string[]): boolean {
    return blocklist.includes(ownerRepo)
}

export async function discoverIssues(config: BaywatchConfig, extraRefs: string[] = []): Promise<DiscoveredIssue[]> {
    const auto = await listAssignedIssues()
    const seen = new Set<string>()
    const out: DiscoveredIssue[] = []
    const push = (i: Issue): void => {
        const key = `${i.repository.nameWithOwner}#${i.number}`
        if (seen.has(key)) return
        if (isBlocked(i.repository.nameWithOwner, config.blocklist)) return
        seen.add(key)
        out.push({ ...i, repoPath: findRepoPath(i.repository.nameWithOwner, config.cloneRoots) })
    }

    for (const i of auto) push(i)

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
        if (r.status === "fulfilled") push(r.value)
        else console.warn(`[discovery] failed to fetch ${ref.ownerRepo}#${ref.num}: ${r.reason}`)
    }
    return out
}

type Candidate = {
    thin: ThinPR
    reason: DiscoveredPR["reasonForReview"]
}

export async function discoverPRs(config: BaywatchConfig, watchlist: string[] = []): Promise<DiscoveredPR[]> {
    const [assigned, reviewRequested] = await Promise.all([listAssignedPRs(), listReviewRequestedPRs()])

    // Dedupe (assigned takes precedence over review-requested if both apply).
    const candidates = new Map<string, Candidate>()
    const addCandidate = (thin: ThinPR, reason: Candidate["reason"]): void => {
        const key = `${thin.repository.nameWithOwner}#${thin.number}`
        if (candidates.has(key)) return
        if (isBlocked(thin.repository.nameWithOwner, config.blocklist)) return
        candidates.set(key, { thin, reason })
    }
    for (const pr of assigned) addCandidate(pr, "assigned")
    for (const pr of reviewRequested) addCandidate(pr, "review-requested")

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
        results.push({
            ...full,
            repoPath: findRepoPath(full.repository.nameWithOwner, config.cloneRoots),
            reasonForReview: candidate.reason,
            alreadyReviewedAtThisHead: !!last && last.headSha === full.headRefOid,
        })
    }
    return results
}
