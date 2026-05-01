import { $ } from "bun"

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
    const json = await $`gh search issues --assignee @me --state open --limit 100 --json ${ISSUE_FIELDS}`.text()
    return JSON.parse(json) as Issue[]
}

export async function listAssignedPRs(): Promise<ThinPR[]> {
    const json = await $`gh search prs --assignee @me --state open --limit 100 --json ${SEARCH_PR_FIELDS}`.text()
    return JSON.parse(json) as ThinPR[]
}

export async function listReviewRequestedPRs(): Promise<ThinPR[]> {
    const json =
        await $`gh search prs --review-requested @me --state open --limit 100 --json ${SEARCH_PR_FIELDS}`.text()
    return JSON.parse(json) as ThinPR[]
}

export async function getPR(ownerRepo: string, num: number): Promise<PR> {
    const json = await $`gh pr view ${num} --repo ${ownerRepo} --json ${FULL_PR_FIELDS}`.text()
    const parsed = JSON.parse(json) as Omit<PR, "repository">
    return { ...parsed, repository: { nameWithOwner: ownerRepo } }
}

const ISSUE_VIEW_FIELDS = "number,title,body,url,labels,updatedAt"

export async function getIssue(ownerRepo: string, num: number): Promise<Issue> {
    const json = await $`gh issue view ${num} --repo ${ownerRepo} --json ${ISSUE_VIEW_FIELDS}`.text()
    const parsed = JSON.parse(json) as Omit<Issue, "repository">
    return { ...parsed, repository: { nameWithOwner: ownerRepo } }
}
