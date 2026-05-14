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
}
