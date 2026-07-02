//
//  GitService.swift
//  baywatch
//
//  Shells out to `git` for diff content. Resolves the default branch from
//  origin/HEAD; falls back to `main` if for some reason that symbolic ref
//  isn't set.
//

import Foundation

enum GitService {
    static func defaultBranch(clonePath: String) -> String {
        let result = CommandRunner.run("git", [
            "-C", clonePath,
            "symbolic-ref", "refs/remotes/origin/HEAD",
        ])
        if result.ok {
            let raw = result.stdout.trimmingCharacters(in: .whitespacesAndNewlines)
            // raw is like "refs/remotes/origin/main"
            if let lastSlash = raw.lastIndex(of: "/") {
                return String(raw[raw.index(after: lastSlash)...])
            }
        }
        return "main"
    }

    /// Diff the agent clone's working tree against the base branch.
    ///
    /// `git diff <base>` only covers tracked file changes; new files the
    /// agent has created (untracked) wouldn't show. We append synthetic
    /// "new file" hunks for each untracked file so the review surface
    /// matches what the user sees in a `git status`.
    static func diff(clonePath: String, from base: String, to _: String) -> String {
        let tracked = CommandRunner.run("git", [
            "-C", clonePath,
            "diff",
            "--no-color",
            base,
        ])
        var output = tracked.ok ? tracked.stdout : ""

        let untracked = CommandRunner.run("git", [
            "-C", clonePath,
            "ls-files",
            "--others",
            "--exclude-standard",
        ])
        guard untracked.ok else { return output }

        let files = untracked.stdout
            .split(separator: "\n")
            .map { String($0).trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        let clone = URL(fileURLWithPath: clonePath)
        for file in files {
            let fullPath = clone.appendingPathComponent(file).path
            guard let content = try? String(contentsOfFile: fullPath, encoding: .utf8) else {
                continue
            }
            output += synthesizeNewFileDiff(path: file, content: content)
        }
        return output
    }

    /// Builds a unified-diff "new file" hunk for an untracked file so our
    /// DiffParser surfaces it alongside tracked changes.
    private static func synthesizeNewFileDiff(path: String, content: String) -> String {
        let lines = content.split(separator: "\n", omittingEmptySubsequences: false)
        var out = ""
        out += "diff --git a/\(path) b/\(path)\n"
        out += "new file mode 100644\n"
        out += "--- /dev/null\n"
        out += "+++ b/\(path)\n"
        out += "@@ -0,0 +1,\(lines.count) @@\n"
        for line in lines { out += "+\(line)\n" }
        return out
    }

    // MARK: - landing (push / PR / status)

    /// Land the agent branch into the main clone (idempotent) then push it to
    /// origin. The main clone's origin is the GitHub remote (the agent clone's
    /// origin is the local main clone), so the push runs from the main clone.
    static func landAndPush(clonePath: String, mainClonePath: String, branch: String) -> (ok: Bool, message: String) {
        _ = CommandRunner.run("git", ["-C", mainClonePath, "fetch", clonePath, "\(branch):\(branch)"])
        let push = CommandRunner.run("git", ["-C", mainClonePath, "push", "-u", "origin", branch])
        return (push.ok, push.ok ? push.stdout : push.stderr)
    }

    /// Open GitHub's "create pull request" flow in the browser for this branch.
    static func createPRWeb(ownerRepo: String, branch: String) {
        _ = CommandRunner.run("gh", ["pr", "create", "-R", ownerRepo, "--head", branch, "--web"])
    }

    /// The PR (if any) for a branch plus its check rollup. nil when the branch
    /// isn't pushed or has no PR yet.
    static func prStatus(ownerRepo: String, branch: String) -> PRStatus? {
        let result = CommandRunner.run("gh", [
            "pr", "view", branch, "-R", ownerRepo,
            "--json", "number,url,state,statusCheckRollup",
        ])
        guard result.ok, let data = result.stdout.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(PRStatus.self, from: data)
    }

    /// Open a clone in the user's editor. Tries VS Code, then Zed, then Finder.
    static func openInEditor(path: String) {
        for app in ["Visual Studio Code", "Zed"] where CommandRunner.run("open", ["-a", app, path]).ok {
            return
        }
        _ = CommandRunner.run("open", [path])
    }
}

// Shape of `gh pr view --json number,url,state,statusCheckRollup`. Rollup
// entries mix CheckRun (status + conclusion) and StatusContext (state).
struct PRStatus: Decodable, Sendable {
    let number: Int
    let url: String
    let state: String
    let statusCheckRollup: [Check]?

    struct Check: Decodable, Sendable {
        let status: String?
        let conclusion: String?
        let state: String?
    }

    enum Rollup: Sendable { case passing, failing, pending, none }

    var rollup: Rollup {
        guard let checks = statusCheckRollup, !checks.isEmpty else { return .none }
        var pass = 0, fail = 0, pend = 0
        for check in checks {
            let verdict = (check.conclusion ?? check.state ?? check.status ?? "").uppercased()
            switch verdict {
            case "SUCCESS", "NEUTRAL", "SKIPPED": pass += 1
            case "FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "ERROR", "STARTUP_FAILURE": fail += 1
            default: pend += 1
            }
        }
        if fail > 0 { return .failing }
        if pend > 0 { return .pending }
        if pass > 0 { return .passing }
        return .none
    }
}
