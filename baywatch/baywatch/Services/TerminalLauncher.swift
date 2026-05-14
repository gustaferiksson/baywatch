//
//  TerminalLauncher.swift
//  baywatch
//
//  Hands off "attach to a session container" to the user's preferred terminal
//  app. Choice persists via AppSettings.terminalAppKey. Each app has its own
//  hand-off mechanism — AppleScript for Terminal/iTerm, command-line flag
//  for Ghostty.
//

import Foundation

enum TerminalLauncher {
    /// Opens the user's preferred terminal app with `tmux attach` into the
    /// claude session in `containerName`.
    static func attachToSession(containerName: String) {
        let command = "podman exec -it \(shellEscape(containerName)) tmux attach -t claude"
        switch preferredApp() {
        case .system: launchTerminal(command: command)
        case .iterm:  launchITerm(command: command)
        case .ghostty: launchGhostty(command: command)
        }
    }

    // MARK: - per-app launchers

    private static func launchTerminal(command: String) {
        let script = """
        tell application "Terminal"
            activate
            do script "\(escapeForAppleScript(command))"
        end tell
        """
        runAppleScript(script)
    }

    private static func launchITerm(command: String) {
        let script = """
        tell application "iTerm"
            activate
            create window with default profile
            tell current session of current window
                write text "\(escapeForAppleScript(command))"
            end tell
        end tell
        """
        runAppleScript(script)
    }

    private static func launchGhostty(command: String) {
        // Ghostty accepts a top-level --command flag that runs in a new window.
        run("/usr/bin/open", args: ["-na", "Ghostty", "--args", "--command=\(command)"])
    }

    // MARK: - helpers

    private static func preferredApp() -> TerminalApp {
        let raw = UserDefaults.standard.string(forKey: AppSettings.terminalAppKey)
            ?? TerminalApp.system.rawValue
        return TerminalApp(rawValue: raw) ?? .system
    }

    private static func runAppleScript(_ script: String) {
        run("/usr/bin/osascript", args: ["-e", script])
    }

    private static func run(_ executable: String, args: [String]) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = args
        do { try task.run() } catch {
            NSLog("TerminalLauncher: failed to spawn \(executable): \(error.localizedDescription)")
        }
    }

    /// Escapes a string for safe inclusion in an AppleScript string literal
    /// (`\` and `"` get doubled-up).
    private static func escapeForAppleScript(_ s: String) -> String {
        s
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    /// Single-quote escape for use inside a /bin/sh command.
    private static func shellEscape(_ s: String) -> String {
        // baywatch container names are limited to [a-z0-9-] so the simple
        // form is fine; we still wrap to be defensive against future names.
        if s.range(of: "[^A-Za-z0-9._-]", options: .regularExpression) == nil { return s }
        return "'\(s.replacingOccurrences(of: "'", with: "'\\''"))'"
    }
}
