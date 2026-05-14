//
//  CommentStore.swift
//  baywatch
//
//  Per-session pending review comments. Loaded from
//  ~/.baywatch/sessions/<id>/comments.json on demand; saved atomically on
//  every change. After "Send to Session", entries are typically cleared.
//

import Foundation
import Observation

@Observable
@MainActor
final class CommentStore {
    private(set) var comments: [Comment] = []
    private(set) var sessionId: String?

    private let fm = FileManager.default

    func load(sessionId: String) {
        self.sessionId = sessionId
        let url = commentsURL(for: sessionId)
        guard let data = try? Data(contentsOf: url) else {
            comments = []
            return
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        comments = (try? decoder.decode([Comment].self, from: data)) ?? []
    }

    func add(_ comment: Comment) {
        comments.append(comment)
        persist()
    }

    func remove(_ comment: Comment) {
        comments.removeAll { $0.id == comment.id }
        persist()
    }

    func clear() {
        comments = []
        persist()
    }

    private func persist() {
        guard let sessionId else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(comments) else { return }
        let url = commentsURL(for: sessionId)
        try? fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic])
    }

    private func commentsURL(for id: String) -> URL {
        fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".baywatch/sessions/\(id)/comments.json")
    }
}
