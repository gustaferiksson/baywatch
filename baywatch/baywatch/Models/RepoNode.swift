//
//  RepoNode.swift
//  baywatch
//
//  Hierarchical view of folders + git repos under the configured repos root.
//  Leaves are git repos; intermediate nodes are folders that contain (directly
//  or transitively) at least one git repo. Empty branches are pruned so the
//  picker doesn't show dead ends.
//

import Foundation

struct RepoNode: Identifiable, Hashable {
    let id: URL
    let isGitRepo: Bool
    let children: [RepoNode]?

    var name: String { id.lastPathComponent }
    var path: URL { id }
}
