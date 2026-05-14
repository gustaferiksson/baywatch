//
//  RepoDiscovery.swift
//  baywatch
//
//  Finds local git clones under ~/Repos/<owner>/<repo>/, mirroring baywatch's
//  cloneRoots convention. Returns `owner/repo` strings sorted alphabetically.
//

import Foundation

enum RepoDiscovery {
    /// Default search root. Picks up the `~/Repos/<owner>/<repo>/.git` pattern
    /// that baywatch's CLI config also relies on.
    static let defaultRoot: URL = FileManager.default
        .homeDirectoryForCurrentUser
        .appendingPathComponent("Repos")

    /// Returns deduplicated `owner/repo` identifiers for every git clone found
    /// two directories deep under `root`. Owner = root-relative parent dir
    /// (`Gustaf` for `~/Repos/Gustaf/baywatch`).
    static func discoverAll(under root: URL = defaultRoot) -> [String] {
        let fm = FileManager.default
        guard fm.fileExists(atPath: root.path) else { return [] }

        var results: Set<String> = []

        guard let ownerEntries = try? fm.contentsOfDirectory(
            at: root,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        for ownerURL in ownerEntries {
            guard isDirectory(ownerURL) else { continue }
            guard let repoEntries = try? fm.contentsOfDirectory(
                at: ownerURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            ) else { continue }

            let owner = ownerURL.lastPathComponent
            for repoURL in repoEntries {
                guard isDirectory(repoURL) else { continue }
                let gitDir = repoURL.appendingPathComponent(".git")
                if fm.fileExists(atPath: gitDir.path) {
                    results.insert("\(owner)/\(repoURL.lastPathComponent)")
                }
            }
        }

        return results.sorted()
    }

    private static func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true
    }
}
