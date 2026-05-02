# Task: review bundle of {{PR_COUNT}} PR(s)

You are reviewing **{{PR_COUNT}} pull requests together as one logical change**. They may live in different repos but they share a goal — usually a single GitHub issue with multiple linked PRs.

{{ISSUE_CONTEXT}}

## PRs in this bundle

{{BUNDLE_BODY}}

## Hard rules

- **Never** post a review to GitHub. Never run `gh pr review`, `gh pr comment`, or any GitHub write command.
- Your output is a single markdown file written to `{{REVIEW_OUTPUT_PATH}}`. The maintainer reads it and submits per-PR reviews themselves using `{{SUBMIT_SCRIPT_PATH}}` as a starting point.

## Severity scale

Tag every individual finding with one of three severities. The verdict at the end maps directly from these.

- **`[critical]`** — must fix before merge. Correctness bug that affects users, data loss, security issue, breaks production code paths, or violates a hard rule.
- **`[high]`** — strongly recommend fixing. Real flaw the maintainer should weigh: bug, type-design problem, missing test, visibility violation.
- **`[low]`** — nit / nice-to-have. Skip findings lower than this.

Format: `- [severity] owner/repo#N file/path.ts:42 — short description` (PR ref before the file path so the maintainer knows which PR each finding belongs to).

## Workflow

For each PR in the bundle, run the same passes as a single-PR review:

1. **Restate the goal** of the individual PR.
2. **Goal vs. implementation** for the individual PR.
3. **Type design** for the individual PR's diff.
4. **Visibility** for the individual PR's diff.
5. **Code-level notes** for the individual PR's diff.

Then — and this is what justifies the bundle:

6. **Cross-PR cohesion**. Specifically:
    - **Goal coverage** — do the PRs together fully fulfill the bundle's goal? Anything implied but not present?
    - **Contracts across boundaries** — when PR A produces something PR B consumes (types, env vars, API endpoints, config keys, db schema), do they agree? Off-by-one in a contract is a `[critical]` here.
    - **Merge order** — does any PR depend on another being merged first? Call it out, not just yes/no — say which order works.
    - **Partial-merge risk** — if only some of these PRs land (release window cuts off, etc.), what breaks? Anything that breaks for partial-merge is at least `[high]`.
    - **Duplication / drift** — same logic repeated across PRs that should have been factored, or two PRs solving the same sub-problem in incompatible ways.

7. **Per-PR verdict** + **bundle verdict**. Mapping (highest severity wins):
    - Any `[critical]` (per-PR or cross-PR) → **Blocking**
    - Any `[high]` → **Needs changes**
    - Only `[low]` → **Approve with minor suggestions**
    - Nothing → **Approve as-is**

## Output

Write one markdown file at `{{REVIEW_OUTPUT_PATH}}` with this structure:

```markdown
# Bundle review — {{PR_COUNT}} PR(s)

**Reviewed at:** [list each PR + its head SHA, one per line]

## Bundle goal (in my words)

…

{{PR_SECTIONS_PLACEHOLDER}}

## Cross-PR cohesion

### Goal coverage
…

### Contracts
…

### Merge order
…

### Partial-merge risk
…

### Duplication / drift
…

## Bundle verdict

- [ ] Approve as-is
- [ ] Approve with minor suggestions
- [ ] Needs changes
- [ ] Blocking — one-line reason

**Severity counts:** _N critical, M high, K low._

## Per-PR verdicts

- owner/repo#A — [verdict]
- owner/repo#B — [verdict]
…
```

For `{{PR_SECTIONS_PLACEHOLDER}}`, write one `## owner/repo#N — Title` section per PR with: Goal, Goal-vs-implementation, Type design, Visibility, Code-level notes. `_no findings._` for empty subsections.

Also write `{{SUBMIT_SCRIPT_PATH}}` — a shell script with one commented-out `gh pr review` line per bundled PR for the maintainer to uncomment selectively.

## Done

<promise>COMPLETE</promise>
