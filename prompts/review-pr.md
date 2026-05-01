# Task: review {{PR_REPO}}#{{PR_NUMBER}}

**Title:** {{PR_TITLE}}
**URL:** {{PR_URL}}
**Branch:** `{{PR_HEAD_REF}}` → `{{PR_BASE_REF}}`
**Head SHA:** {{PR_HEAD_OID}}

## PR body

{{PR_BODY}}

## Additional notes from the maintainer

These are free-form notes the maintainer left for this review. Treat them as **higher priority than the PR body** — they're more recent and more specific. They may flag things they want you to scrutinize, things to skip, or context that didn't make it into the PR description.

{{ADDITIONAL_NOTES}}

## Diff

```diff
{{PR_DIFF}}
```

## Hard rules

- **Never** post a review to GitHub. Never run `gh pr review`, `gh pr comment`, or any GitHub write command.
- Your output is a markdown file written to `{{REVIEW_OUTPUT_PATH}}`. The maintainer reads it and submits the review themselves.

## Workflow

Run these passes in order. Each lands a section in the output markdown.

### 1. Restate the goal

Read the title and body. In your own words, write what this PR is *trying to achieve* — the user-visible outcome or technical state, not the implementation. Be specific. If the PR is multi-purpose, list each goal.

### 2. Goal vs. implementation

Given the goal you just wrote, ask: if you were starting from scratch with the same goal, would you do it this way? Are there architecturally simpler / more direct approaches that the chosen implementation didn't take? Note specific alternatives, even if impractical now. Call out *why* the chosen approach was taken when it's defensible.

### 3. Type design

Walk every TypeScript type added or modified in the diff. For each, ask:

- Could `optional field + boolean flag` become a discriminated union?
- Are there `as` casts that should be a type guard or runtime parse?
- Are nullable / optional chains hiding state that should be modeled explicitly?
- Are types as fluid, neat, and easy-to-read as they could be? Specifically: would renaming, splitting, or merging types make consuming code cleaner?

Cite the file:line for each note.

### 4. Visibility

Walk the diff for hidden abstractions:

- Lazy auto-init in getters (functions whose first call has hidden side effects)?
- Detect-and-execute coupled in one function?
- Cross-domain reads (one domain function reaching into another's state)?
- Silent fallbacks (try/catch where the caller never learns which path ran)?
- `console.log` or other side-effect calls inside library code?
- Barrel re-exports that hide where things live?

### 5. Code-level notes

Now line-level. Bugs, off-by-ones, race conditions, silent error swallowing, test coverage gaps for the new behavior, comments that just restate code, dead code, leftover debugging.

### 6. Verdict

Pick one: approve as-is / approve with minor suggestions / needs changes / blocking.

## Output

Write the review to `{{REVIEW_OUTPUT_PATH}}` with this structure:

```markdown
# {{PR_REPO}}#{{PR_NUMBER}} — {{PR_TITLE}}

**Reviewed at head:** {{PR_HEAD_OID}}

## Goal (in my words)

…

## Goal vs. implementation

…

## Type design

…

## Visibility

…

## Code-level notes

…

## Verdict

- [ ] Approve as-is
- [ ] Approve with minor suggestions
- [ ] Needs changes
- [ ] Blocking — one-line reason
```

Also write `{{SUBMIT_SCRIPT_PATH}}` — a shell script the maintainer runs themselves. Default to commented out; the maintainer uncomments after reading:

```sh
#!/usr/bin/env bash
# Submit the review to GitHub. The maintainer runs this themselves.
# Uncomment one of:
#
# gh pr review {{PR_NUMBER}} --repo {{PR_REPO}} --approve
# gh pr review {{PR_NUMBER}} --repo {{PR_REPO}} --comment --body-file {{REVIEW_OUTPUT_PATH}}
# gh pr review {{PR_NUMBER}} --repo {{PR_REPO}} --request-changes --body-file {{REVIEW_OUTPUT_PATH}}
echo "Review for {{PR_REPO}}#{{PR_NUMBER}} not submitted. Edit this file and uncomment one of the gh commands above."
```

## Done

<promise>COMPLETE</promise>
