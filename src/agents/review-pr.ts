import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"

import type { BaywatchConfig } from "../config.ts"
import type { DiscoveredPR } from "../discovery.ts"

export async function reviewPR(opts: { pr: DiscoveredPR; config: BaywatchConfig; dryRun: boolean }): Promise<void> {
    const { pr, dryRun } = opts
    const ownerRepo = pr.repository.nameWithOwner

    if (pr.alreadyReviewedAtThisHead) {
        console.log(`[review] ${ownerRepo}#${pr.number} — already reviewed at ${pr.headRefOid.slice(0, 7)}, skipping`)
        return
    }

    const reviewDir = path.resolve(process.cwd(), "reviews")
    if (!existsSync(reviewDir)) mkdirSync(reviewDir, { recursive: true })
    const reviewPath = path.join(reviewDir, `${ownerRepo.replace("/", "__")}__${pr.number}.md`)

    console.log(
        `[review] ${ownerRepo}#${pr.number} (${pr.reasonForReview}) → ${path.relative(process.cwd(), reviewPath)}`
    )

    if (dryRun) {
        console.log(`[review]   (dry-run) would run sandcastle review agent and write ${reviewPath}`)
        return
    }

    // TODO(iter-2): wire @ai-hero/sandcastle review agent here.
    //   Output: write a markdown review to reviewPath plus a submit-review.sh that the human runs manually.
    //   On success: recordReview({ ownerRepo, prNumber: pr.number, headSha: pr.headRefOid, reviewedAt: Date.now(), reviewPath })
    console.log("[review]   (stub) sandcastle review wiring not yet implemented")
    return Promise.resolve()
}
