//
//  TmuxBridge.swift
//  baywatch
//
//  Sends a string to the claude TUI running inside a session's container.
//  Uses `tmux send-keys` via `podman exec`. Multi-line messages are sent
//  via a temporary file inside the container to avoid newline shell-quoting
//  hell — tmux paste-buffer-style.
//

import Foundation

enum TmuxBridge {
    /// Sends `message` to the `claude` tmux session in `containerName`.
    /// Returns true on success.
    @discardableResult
    static func send(containerName: String, message: String) -> Bool {
        // Stage the message in a temp file inside the container so multi-line,
        // arbitrary-quote content travels intact. tmux load-buffer + paste-buffer
        // is the canonical way to do this.
        let stagePath = "/tmp/baywatch-msg-\(UUID().uuidString).txt"

        // Write the file via `tee`, which we can pipe to without quoting issues.
        let writeResult = CommandRunner.run(
            "podman",
            ["exec", "-i", containerName, "tee", stagePath],
            stdin: message
        )
        guard writeResult.ok else { return false }

        // Load into a tmux buffer named baywatch-input, paste into the claude
        // pane, then submit with Enter, then delete the file.
        let bufferName = "baywatch-input"
        let cmd = """
        tmux load-buffer -b \(bufferName) \(stagePath) && \
        tmux paste-buffer -b \(bufferName) -t claude && \
        tmux send-keys -t claude Enter && \
        tmux delete-buffer -b \(bufferName) ; \
        rm -f \(stagePath)
        """
        let runResult = CommandRunner.run("podman", ["exec", containerName, "sh", "-c", cmd])
        return runResult.ok
    }
}
