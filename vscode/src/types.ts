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
    errorSummary: string | null
}

export type RunDetail = RunEntry & {
    agentClonePath: string | null
    reviewPath: string | null
}

export type DoctorCheck = {
    name: string
    status: "ok" | "warn" | "fail"
    detail: string
    hint?: string
}

export type LinkedPR = { number: number; title: string; url: string }

export type IssueRef = {
    ref: string
    title: string
    hasClone: boolean
    blockedByPRs: number[]
    linkedOpenPRs: LinkedPR[]
    url: string
    ownerRepo: string
    number: number
    state: "open" | "implemented"
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
    lastReviewedAt: number | null
    lastReviewedHead: string | null
    reviewState: "reviewed" | "stale" | "unreviewed"
}
