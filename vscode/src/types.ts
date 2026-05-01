// Shared types — match the JSON contracts emitted by the baywatch CLI.

export type RunStatus = "running" | "success" | "failed" | "cancelled"

export type RunEntry = {
    runId: number
    kind: "dev" | "review"
    status: RunStatus
    target: string
    ownerRepo: string
    branch: string | null
    startedAt: string
    finishedAt: string | null
    logPath: string | null
}

export type RunDetail = RunEntry & {
    agentClonePath: string | null
    reviewPath: string | null
}

export type IssueRef = {
    ref: string
    title: string
    hasClone: boolean
    blockedByPRs: number[]
    url: string
    ownerRepo: string
    number: number
}

export type PrRef = {
    ref: string
    title: string
    hasClone: boolean
    reasonForReview: string
    alreadyReviewedAtThisHead: boolean
    headRefOid: string
    url: string
    ownerRepo: string
    number: number
}
