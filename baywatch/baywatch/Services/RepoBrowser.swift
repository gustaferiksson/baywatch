//
//  RepoBrowser.swift
//  baywatch
//
//  Walks the configured repos root recursively (bounded depth) and builds a
//  RepoNode tree of folders + git repos. Used by the New Session sheet.
//

import Foundation

enum RepoBrowser {
    /// Max recursion depth from the root. 4 levels covers `~/Repos/<owner>/<repo>`
    /// comfortably and gives headroom for nested workspaces without scanning
    /// arbitrarily deep trees.
    static let maxDepth = 4

    /// Returns the top-level children of `root`, pruning any subtree that
    /// contains no git repos. `root` is expanded (`~` → home).
    static func browse(root: URL) -> [RepoNode] {
        let resolved = resolved(url: root)
        guard FileManager.default.fileExists(atPath: resolved.path) else { return [] }
        return childrenOf(resolved, depth: 0)
    }

    /// Resolves `owner/repo`-style identifier from a selected git-repo URL by
    /// taking the last two path components. baywatch's CLI uses this string
    /// to find the repo via its `cloneRoots`.
    static func ownerRepoIdentifier(for url: URL) -> String {
        let parts = url.pathComponents.suffix(2)
        return parts.joined(separator: "/")
    }

    // MARK: - private

    private static func childrenOf(_ url: URL, depth: Int) -> [RepoNode] {
        guard depth <= maxDepth else { return [] }
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var nodes: [RepoNode] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            if let node = makeNode(for: entry, depth: depth + 1) {
                nodes.append(node)
            }
        }
        return nodes.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    private static func makeNode(for url: URL, depth: Int) -> RepoNode? {
        let fm = FileManager.default
        // A folder is a git repo if it has a .git child (file or directory —
        // worktrees use a file pointer).
        if fm.fileExists(atPath: url.appendingPathComponent(".git").path) {
            return RepoNode(id: url, isGitRepo: true, children: nil)
        }
        // Otherwise, only keep it if it has git repos somewhere underneath.
        let kids = childrenOf(url, depth: depth)
        guard !kids.isEmpty else { return nil }
        return RepoNode(id: url, isGitRepo: false, children: kids)
    }

    private static func resolved(url: URL) -> URL {
        let raw = url.path
        if raw.hasPrefix("~/") {
            let home = FileManager.default.homeDirectoryForCurrentUser.path
            return URL(fileURLWithPath: home + raw.dropFirst(1))
        }
        return url
    }
}
