import { isCancel, multiselect } from "@clack/prompts"

import type { DiscoveredIssue, DiscoveredPR } from "./discovery.ts"

export async function pickIssues(issues: DiscoveredIssue[]): Promise<DiscoveredIssue[]> {
    if (issues.length === 0) return []
    const result = await multiselect({
        message: "Pick issues to implement (space to select, enter to confirm):",
        options: issues.map((i) => {
            const parts: string[] = []
            if (!i.repoPath) parts.push("no clone")
            if (i.linkedOpenPRs.length > 0) parts.push(`blocked by PR #${i.linkedOpenPRs[0]?.number}`)
            return {
                value: i,
                label: `${i.repository.nameWithOwner}#${i.number}  ${i.title}`,
                ...(parts.length > 0 ? { hint: parts.join(", ") } : {}),
            }
        }),
        required: false,
    })
    if (isCancel(result)) {
        console.log("Cancelled.")
        process.exit(0)
    }
    return result as DiscoveredIssue[]
}

export async function pickPRs(prs: DiscoveredPR[]): Promise<DiscoveredPR[]> {
    if (prs.length === 0) return []
    const result = await multiselect({
        message: "Pick PRs to review (space to select, enter to confirm):",
        options: prs.map((pr) => {
            const parts: string[] = [pr.reasonForReview]
            if (!pr.repoPath) parts.push("no clone")
            if (pr.alreadyReviewedAtThisHead) parts.push("reviewed-at-head")
            return {
                value: pr,
                label: `${pr.repository.nameWithOwner}#${pr.number}  ${pr.title}`,
                hint: parts.join(", "),
            }
        }),
        required: false,
    })
    if (isCancel(result)) {
        console.log("Cancelled.")
        process.exit(0)
    }
    return result as DiscoveredPR[]
}
