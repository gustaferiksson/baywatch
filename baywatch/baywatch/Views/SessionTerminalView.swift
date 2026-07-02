//
//  SessionTerminalView.swift
//  baywatch
//
//  Live PTY-backed terminal showing the claude tmux session inside the
//  container. Wraps SwiftTerm's LocalProcessTerminalView in an
//  NSViewRepresentable so it slots into the SwiftUI split view.
//
//  Requires the SwiftTerm package dependency:
//      https://github.com/migueldeicaza/SwiftTerm
//

import SwiftUI
import AppKit
import SwiftTerm

struct SessionTerminalView: NSViewRepresentable, Equatable {
    let containerName: String
    @AppStorage(AppSettings.fontNameKey) private var fontName = AppSettings.fontNameDefault
    @AppStorage(AppSettings.fontSizeKey) private var fontSize = AppSettings.fontSizeDefault

    static func == (lhs: SessionTerminalView, rhs: SessionTerminalView) -> Bool {
        lhs.containerName == rhs.containerName
    }

    func makeNSView(context: Context) -> LocalProcessTerminalView {
        let view = LocalProcessTerminalView(frame: .zero)
        view.processDelegate = context.coordinator
        // Explicit crisp monospaced font (SwiftTerm's default renders stretched
        // / soft). User-configurable in Settings; falls back to the system mono.
        view.font = AppSettings.monospaceFont(name: fontName, size: fontSize)
        startProcess(in: view)
        return view
    }

    func updateNSView(_ nsView: LocalProcessTerminalView, context: Context) {
        // Intentional no-op. Session switching is driven by `.id(session.id)`
        // at the call site, which causes SwiftUI to dismantle this view and
        // build a fresh one — much cleaner than trying to swap PTY-backed
        // processes inside a single LocalProcessTerminalView.
        _ = (nsView, context)
    }

    static func dismantleNSView(_ nsView: LocalProcessTerminalView, coordinator: Coordinator) {
        // Best-effort: kill the spawned `podman exec -it tmux attach` child
        // process so we don't leak it. SwiftTerm doesn't always do this on
        // its own when the view goes out of scope.
        nsView.send(txt: "\u{04}") // EOT: detach tmux client cleanly first
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    private func startProcess(in view: LocalProcessTerminalView) {
        guard let podman = CommandRunner.resolve("podman") else { return }
        view.startProcess(
            executable: podman.path,
            args: ["exec", "-it", containerName, "tmux", "attach", "-t", "claude"],
            environment: defaultEnvironment(),
            execName: "podman"
        )
    }

    /// Environment passed to the PTY child. We don't blindly inherit the GUI
    /// app's env (which lacks /opt/homebrew/bin); instead, set TERM and PATH
    /// explicitly so the embedded shell+tmux render colours correctly.
    private func defaultEnvironment() -> [String] {
        [
            "TERM=xterm-256color",
            "LANG=en_US.UTF-8",
            "LC_ALL=en_US.UTF-8",
            "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            "HOME=\(NSHomeDirectory())",
        ]
    }

    final class Coordinator: NSObject, LocalProcessTerminalViewDelegate {
        let parent: SessionTerminalView

        init(_ parent: SessionTerminalView) {
            self.parent = parent
        }

        func sizeChanged(source: LocalProcessTerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: LocalProcessTerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func processTerminated(source: TerminalView, exitCode: Int32?) {}
    }
}
