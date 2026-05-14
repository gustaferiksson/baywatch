//
//  CommandRunner.swift
//  baywatch
//
//  GUI macOS apps inherit a minimal PATH (typically `/usr/bin:/bin:...`) so
//  spawning `podman` / `baywatch` / `tmux` via `/usr/bin/env` silently fails.
//  This resolves binaries from the standard homebrew + system locations and
//  invokes them with the resolved absolute path.
//

import Foundation

enum CommandRunner {
    /// Directories searched, in order, when resolving a command name.
    private static let searchPath: [String] = [
        "\(NSHomeDirectory())/.bun/bin",   // `bun link` puts baywatch here
        "\(NSHomeDirectory())/.local/bin", // alt CLI install location
        "/opt/homebrew/bin",                // Apple Silicon homebrew
        "/usr/local/bin",                   // Intel homebrew / manually installed
        "/usr/bin",                         // system
        "/bin",
    ]

    struct Result {
        let exitCode: Int32
        let stdout: String
        let stderr: String

        var ok: Bool { exitCode == 0 }
    }

    /// Returns the first executable matching `command` on the standard search
    /// path, or nil. Cached per command name for the process lifetime since
    /// brew paths don't move while the app is running.
    static func resolve(_ command: String) -> URL? {
        if let cached = cache[command] { return cached }
        let fm = FileManager.default
        for dir in searchPath {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(command)
            if fm.isExecutableFile(atPath: url.path) {
                cache[command] = url
                return url
            }
        }
        return nil
    }

    /// Synchronous run — fine for short, predictable commands like
    /// `podman ps -q` or `git diff`. Long-running commands should use a
    /// detached Task and pipe output incrementally.
    static func run(_ command: String, _ args: [String], stdin: String? = nil) -> Result {
        guard let url = resolve(command) else {
            return Result(exitCode: -1, stdout: "", stderr: "command not found: \(command)")
        }
        let proc = Process()
        proc.executableURL = url
        proc.arguments = args
        proc.environment = enrichedEnvironment()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        proc.standardOutput = stdoutPipe
        proc.standardError = stderrPipe
        if let stdin {
            let stdinPipe = Pipe()
            proc.standardInput = stdinPipe
            do {
                try proc.run()
            } catch {
                return Result(exitCode: -1, stdout: "", stderr: error.localizedDescription)
            }
            if let data = stdin.data(using: .utf8) {
                try? stdinPipe.fileHandleForWriting.write(contentsOf: data)
            }
            try? stdinPipe.fileHandleForWriting.close()
        } else {
            do {
                try proc.run()
            } catch {
                return Result(exitCode: -1, stdout: "", stderr: error.localizedDescription)
            }
        }
        proc.waitUntilExit()
        let stdoutData = (try? stdoutPipe.fileHandleForReading.readToEnd()) ?? Data()
        let stderrData = (try? stderrPipe.fileHandleForReading.readToEnd()) ?? Data()
        return Result(
            exitCode: proc.terminationStatus,
            stdout: String(data: stdoutData, encoding: .utf8) ?? "",
            stderr: String(data: stderrData, encoding: .utf8) ?? ""
        )
    }

    /// Builds an environment dictionary that prepends our standard search
    /// path to PATH so that subprocess-of-subprocess invocations (e.g.
    /// `baywatch` shelling out to `podman`/`git`/`gh`) can resolve commands
    /// the GUI-app inherited PATH never had.
    private static func enrichedEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let prepend = searchPath.joined(separator: ":")
        let existing = env["PATH"] ?? ""
        env["PATH"] = existing.isEmpty ? prepend : "\(prepend):\(existing)"
        return env
    }

    nonisolated(unsafe) private static var cache: [String: URL] = [:]
}
