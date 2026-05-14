//
//  DiffStore.swift
//  baywatch
//
//  Loads + caches the parsed diff for the currently-selected session. Refresh
//  is explicit (button + when the user picks a different session); we don't
//  poll on a timer because git diff on a large repo isn't free.
//

import Foundation
import Observation

@Observable
@MainActor
final class DiffStore {
    private(set) var diff: ParsedDiff = ParsedDiff(files: [])
    private(set) var isLoading: Bool = false
    private(set) var lastError: String?
    private(set) var sessionId: String?

    func load(session: Session) {
        // Skip if we've already loaded this session's diff and there's no
        // explicit refresh request — caller calls refresh() to force a reload.
        if sessionId == session.id, !diff.isEmpty { return }
        refresh(session: session)
    }

    func refresh(session: Session) {
        sessionId = session.id
        isLoading = true
        Task.detached(priority: .userInitiated) { [clonePath = session.meta.clonePath, branch = session.meta.branch] in
            let base = GitService.defaultBranch(clonePath: clonePath)
            let raw = GitService.diff(clonePath: clonePath, from: base, to: branch)
            let parsed = DiffParser.parse(raw)
            await MainActor.run {
                self.diff = parsed
                self.isLoading = false
                self.lastError = nil
            }
        }
    }
}
