//
//  SessionActions.swift
//  baywatch
//
//  Thin wrapper around the baywatch CLI for session mutations. Every entry
//  point is async + dispatches the blocking subprocess work to a detached
//  task so SwiftUI button actions don't beachball the main thread while the
//  CLI (which is itself slow — clone, container start, RC register) runs.
//

import Foundation

enum SessionActions {
    struct Failure: Error {
        let message: String
    }

    static func stop(sessionId: String) async throws {
        try await runDetached(["session", "stop", sessionId])
    }

    static func remove(sessionId: String) async throws {
        try await runDetached(["session", "rm", sessionId])
    }

    /// Spawns a new sandboxed session across one or more repos (a new task).
    /// Typical wall-clock: 3–8s per repo (clone + container start + RC).
    static func create(repos: [String], name: String?) async throws {
        var args = ["session", "new"] + repos
        if let name, !name.isEmpty {
            args.append("--name")
            args.append(name)
        }
        try await runDetached(args)
    }

    /// Reopen an existing task's branches (with their commits) in a fresh session.
    static func continueTask(taskId: String) async throws {
        try await runDetached(["session", "continue", taskId])
    }

    /// Add a repo to a live session — appears in the container without a restart.
    static func addRepo(sessionId: String, repo: String) async throws {
        try await runDetached(["session", "add-repo", sessionId, repo])
    }

    private static func runDetached(_ args: [String]) async throws {
        try await Task.detached(priority: .userInitiated) {
            let result = CommandRunner.run("baywatch", args)
            guard result.ok else {
                let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                throw Failure(message: "baywatch \(args.joined(separator: " ")) failed: \(stderr.isEmpty ? "(no stderr)" : stderr)")
            }
        }.value
    }
}
