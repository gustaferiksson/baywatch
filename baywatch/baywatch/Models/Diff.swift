//
//  Diff.swift
//  baywatch
//
//  Structured view of a unified diff. Hand-rolled parser — saves a dependency
//  and the grammar is small. Produces enough information to render hunks with
//  per-line metadata (kind, line numbers) so we can attach comments to lines.
//

import Foundation

struct ParsedDiff: Hashable {
    let files: [DiffFile]
    var isEmpty: Bool { files.isEmpty }
}

struct DiffFile: Hashable, Identifiable {
    enum Status { case modified, added, deleted, renamed }

    let path: String           // new path (or old, for deletions)
    let oldPath: String?       // present when renamed
    let status: Status
    let hunks: [DiffHunk]

    var id: String { path }
}

struct DiffHunk: Hashable, Identifiable {
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int
    let header: String         // the `@@ -a,b +c,d @@ context` line
    let lines: [DiffLine]

    var id: String { header }
}

struct DiffLine: Hashable, Identifiable {
    enum Kind { case context, addition, deletion }

    let kind: Kind
    let content: String        // without the leading +/-/space marker
    let oldLineNumber: Int?
    let newLineNumber: Int?

    /// Stable id within a hunk; concatenate hunk header for full uniqueness.
    let id: Int                // index within the hunk
}

enum DiffParser {
    /// Parses a `git diff` unified output. Robust enough for our case
    /// (single working repo, no binary files, no submodule diffs).
    static func parse(_ text: String) -> ParsedDiff {
        var files: [DiffFile] = []
        var currentFile: PartialFile?

        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var i = 0
        while i < lines.count {
            let line = lines[i]

            if line.hasPrefix("diff --git ") {
                if let f = currentFile?.finalize() { files.append(f) }
                currentFile = PartialFile(headerLine: line)
                i += 1
                continue
            }

            guard var file = currentFile else { i += 1; continue }

            if line.hasPrefix("new file mode") { file.status = .added }
            else if line.hasPrefix("deleted file mode") { file.status = .deleted }
            else if line.hasPrefix("rename from ") {
                file.oldPath = String(line.dropFirst("rename from ".count))
                file.status = .renamed
            } else if line.hasPrefix("rename to ") {
                file.path = String(line.dropFirst("rename to ".count))
            } else if line.hasPrefix("--- a/") {
                file.oldPath = String(line.dropFirst("--- a/".count))
            } else if line.hasPrefix("--- /dev/null") {
                file.status = .added
            } else if line.hasPrefix("+++ b/") {
                file.path = String(line.dropFirst("+++ b/".count))
            } else if line.hasPrefix("+++ /dev/null") {
                file.status = .deleted
            } else if line.hasPrefix("@@") {
                let (hunk, consumed) = parseHunk(lines: lines, startIndex: i)
                if let hunk { file.hunks.append(hunk) }
                i += consumed
                currentFile = file
                continue
            }

            currentFile = file
            i += 1
        }

        if let f = currentFile?.finalize() { files.append(f) }
        return ParsedDiff(files: files)
    }

    private static func parseHunk(lines: [String], startIndex: Int) -> (DiffHunk?, Int) {
        let header = lines[startIndex]
        guard let (oldStart, oldCount, newStart, newCount) = parseHunkHeader(header) else {
            return (nil, 1)
        }

        var result: [DiffLine] = []
        var oldLine = oldStart
        var newLine = newStart
        var idx = startIndex + 1
        var localId = 0

        while idx < lines.count {
            let line = lines[idx]
            if line.hasPrefix("diff --git ") || line.hasPrefix("@@") { break }

            let marker = line.first
            let content = line.isEmpty ? "" : String(line.dropFirst())
            switch marker {
            case "+":
                result.append(DiffLine(kind: .addition, content: content, oldLineNumber: nil, newLineNumber: newLine, id: localId))
                newLine += 1
            case "-":
                result.append(DiffLine(kind: .deletion, content: content, oldLineNumber: oldLine, newLineNumber: nil, id: localId))
                oldLine += 1
            case " ":
                result.append(DiffLine(kind: .context, content: content, oldLineNumber: oldLine, newLineNumber: newLine, id: localId))
                oldLine += 1
                newLine += 1
            case "\\":
                // "\ No newline at end of file" — ignore for our purposes
                break
            default:
                // Empty separator line at the very end of a hunk
                if line.isEmpty { break }
            }
            localId += 1
            idx += 1
        }

        let hunk = DiffHunk(
            oldStart: oldStart,
            oldCount: oldCount,
            newStart: newStart,
            newCount: newCount,
            header: header,
            lines: result
        )
        return (hunk, idx - startIndex)
    }

    /// "@@ -1,7 +1,8 @@ optional context"
    private static func parseHunkHeader(_ line: String) -> (Int, Int, Int, Int)? {
        // Grab the "-a,b +c,d" portion between the @@
        guard let first = line.range(of: "@@"),
              let second = line.range(of: "@@", range: first.upperBound..<line.endIndex) else {
            return nil
        }
        let body = line[first.upperBound..<second.lowerBound]
            .trimmingCharacters(in: .whitespaces)

        let parts = body.split(separator: " ")
        guard parts.count >= 2 else { return nil }
        guard let (oldStart, oldCount) = parseRange(parts[0].dropFirst()) else { return nil }
        guard let (newStart, newCount) = parseRange(parts[1].dropFirst()) else { return nil }
        return (oldStart, oldCount, newStart, newCount)
    }

    /// Parses `a` or `a,b` (the bit after `-` or `+` in a hunk header).
    private static func parseRange(_ s: Substring) -> (Int, Int)? {
        let comps = s.split(separator: ",")
        guard let first = comps.first, let start = Int(first) else { return nil }
        let count = comps.count > 1 ? (Int(comps[1]) ?? 1) : 1
        return (start, count)
    }

    private struct PartialFile {
        var path: String = ""
        var oldPath: String?
        var status: DiffFile.Status = .modified
        var hunks: [DiffHunk] = []

        init(headerLine: String) {
            // `diff --git a/<path> b/<path>` — grab the b-path as a best-effort
            // default so files with no `+++` header (rare, but pure renames)
            // still surface.
            let parts = headerLine.split(separator: " ")
            if parts.count >= 4 {
                let b = String(parts[3])
                if b.hasPrefix("b/") { path = String(b.dropFirst(2)) }
            }
        }

        func finalize() -> DiffFile? {
            guard !path.isEmpty || oldPath != nil else { return nil }
            return DiffFile(
                path: path.isEmpty ? (oldPath ?? "?") : path,
                oldPath: oldPath,
                status: status,
                hunks: hunks
            )
        }
    }
}
