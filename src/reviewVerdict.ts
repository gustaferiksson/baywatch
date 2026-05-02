// Verdict parsed from a review markdown file. Matches the four checkbox options the
// review prompt asks the agent to choose from. `null` if no checkbox is checked.
export type ReviewVerdict = "approve" | "approve-minor" | "needs-changes" | "blocking" | null

const PATTERNS: ReadonlyArray<{ verdict: Exclude<ReviewVerdict, null>; pattern: RegExp }> = [
    { verdict: "blocking", pattern: /^\s*-\s*\[x\]\s*Blocking/im },
    { verdict: "needs-changes", pattern: /^\s*-\s*\[x\]\s*Needs changes/im },
    { verdict: "approve-minor", pattern: /^\s*-\s*\[x\]\s*Approve with minor suggestions/im },
    { verdict: "approve", pattern: /^\s*-\s*\[x\]\s*Approve as-is/im },
]

// Order matters: blocking is the most-severe verdict; if multiple boxes are
// checked (shouldn't happen but agents misbehave), the most-severe wins so
// the maintainer doesn't get a false "approved" signal.
export function parseVerdict(markdown: string): ReviewVerdict {
    for (const { verdict, pattern } of PATTERNS) {
        if (pattern.test(markdown)) return verdict
    }
    return null
}
