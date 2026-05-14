//
//  Comment.swift
//  baywatch
//
//  Inline review comment tied to a file+line in the session's diff. Persisted
//  per session at ~/.baywatch/sessions/<id>/comments.json so they survive
//  across app restarts.
//

import Foundation

struct Comment: Codable, Hashable, Identifiable {
    let id: UUID
    let file: String
    let line: Int
    let snippet: String      // the line of code the comment hangs off of
    var body: String
    let createdAt: Date

    init(file: String, line: Int, snippet: String, body: String) {
        self.id = UUID()
        self.file = file
        self.line = line
        self.snippet = snippet
        self.body = body
        self.createdAt = Date()
    }
}
