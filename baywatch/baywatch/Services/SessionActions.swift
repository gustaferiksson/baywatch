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

    /// Spawns a new sandboxed session across one or more repos (a new task) and
    /// returns the new session's id, parsed from `session new --json`.
    @discardableResult
    static func create(repos: [String], name: String?) async throws -> String {
        var args = ["session", "new"] + repos + ["--json"]
        if let name, !name.isEmpty {
            args.append("--name")
            args.append(name)
        }
        let output = try await runDetachedCapturing(args)
        // The CLI logs `[clone] …` before the JSON payload, so take the last
        // line that looks like a JSON object.
        let jsonLine = output
            .split(separator: "\n")
            .last(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("{") })
            .map(String.init) ?? ""
        guard let data = jsonLine.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = object["id"] as? String
        else {
            throw Failure(message: "couldn't read new session id from CLI output")
        }
        return id
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
        _ = try await runDetachedCapturing(args)
    }

    @discardableResult
    private static func runDetachedCapturing(_ args: [String]) async throws -> String {
        try await Task.detached(priority: .userInitiated) {
            let result = CommandRunner.run("baywatch", args)
            guard result.ok else {
                let stderr = result.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                throw Failure(message: "baywatch \(args.joined(separator: " ")) failed: \(stderr.isEmpty ? "(no stderr)" : stderr)")
            }
            return result.stdout
        }.value
    }
}
