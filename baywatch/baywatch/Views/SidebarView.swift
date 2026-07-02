//
//  SidebarView.swift
//  baywatch
//
//  Sessions list with live state. Sidebar follows macOS HIG: source-list
//  styling, secondary-label subtitles, semantic state colour, native row
//  selection.
//

import SwiftUI
import AppKit

struct SidebarView: View {
    @Environment(SessionStore.self) private var store
    @Binding var selection: Session.ID?
    @Binding var showNewSessionSheet: Bool
    @State private var pendingRemoval: Session?
    @State private var actionError: String?

    var body: some View {
        List(selection: $selection) {
            if store.groups.isEmpty {
                Section("Tasks") {
                    emptyState
                        .listRowSeparator(.hidden)
                }
            } else {
                ForEach(store.groups) { group in
                    Section {
                        ForEach(group.sessions) { session in
                            SessionRow(session: session)
                                .tag(session.id)
                                .contextMenu { contextMenu(for: session) }
                        }
                    } header: {
                        TaskHeader(group: group)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Baywatch")
        .navigationSubtitle(subtitle)
        .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        .background {
            // Hidden button hosts the ⌘⌫ shortcut. Triggers the same confirm
            // dialog as the context menu / detail-header menu.
            Button("Remove Selected Session") {
                guard let id = selection,
                      let session = store.sessions.first(where: { $0.id == id })
                else { return }
                pendingRemoval = session
            }
            .keyboardShortcut(.delete, modifiers: [.command])
            .opacity(0)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
        }
        .confirmationDialog(
            "Remove this session?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { session in
            Button("Remove “\(session.meta.name)”", role: .destructive) {
                performRemove(session)
            }
            Button("Cancel", role: .cancel) { pendingRemoval = nil }
        } message: { session in
            Text("This stops the container and deletes the agent clone(s). Local commits have already been fetched into your main clone(s).")
        }
        .alert("Action failed", isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button("OK", role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    private var bottomBar: some View {
        HStack(spacing: 6) {
            Button {
                showNewSessionSheet = true
            } label: {
                Label("New Session", systemImage: "plus")
                    .labelStyle(.titleAndIcon)
                    .font(.callout)
            }
            .buttonStyle(.borderless)
            .help("Create a new sandboxed session (⌘N)")
            Spacer()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.bar)
        .overlay(Divider(), alignment: .top)
    }

    @ViewBuilder
    private func contextMenu(for session: Session) -> some View {
        if let url = session.meta.rcEnvironmentUrl.flatMap(URL.init(string:)) {
            Button {
                NSWorkspace.shared.open(url)
            } label: {
                Label("Open in claude.ai/code", systemImage: "safari")
            }
        }
        Button {
            TerminalLauncher.attachToSession(containerName: session.meta.containerName)
        } label: {
            Label("Attach in Terminal", systemImage: "terminal")
        }
        Divider()
        Button {
            performStop(session)
        } label: {
            Label("Stop Session", systemImage: "stop.circle")
        }
        .disabled(session.state == .stopped || session.state == .done)
        Button(role: .destructive) {
            pendingRemoval = session
        } label: {
            Label("Remove Session…", systemImage: "trash")
        }
    }

    private func performStop(_ session: Session) {
        Task {
            do {
                try await SessionActions.stop(sessionId: session.id)
                store.refresh()
            } catch let failure as SessionActions.Failure {
                actionError = failure.message
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func performRemove(_ session: Session) {
        pendingRemoval = nil
        let idToRemove = session.id
        let isSelected = selection == idToRemove
        Task {
            do {
                try await SessionActions.remove(sessionId: idToRemove)
                if isSelected { selection = nil }
                store.refresh()
            } catch let failure as SessionActions.Failure {
                actionError = failure.message
            } catch {
                actionError = error.localizedDescription
            }
        }
    }


    private var subtitle: String {
        let n = store.sessions.count
        if n == 0 { return "No sessions" }
        let needs = store.sessions.filter { $0.state == .awaitingInput }.count
        if needs > 0 { return "\(needs) need input · \(n) total" }
        return "\(n) session\(n == 1 ? "" : "s")"
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("No sessions yet")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Use `baywatch session new` to spawn one.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 8)
    }
}

private struct TaskHeader: View {
    let group: SessionGroup

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(group.taskName)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            if !group.repoSummary.isEmpty {
                Text(group.repoSummary)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        }
    }
}

private struct SessionRow: View {
    let session: Session

    var body: some View {
        HStack(spacing: 10) {
            StateDot(state: session.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.meta.name)
                    .lineLimit(1)
                Text(session.meta.repos.map { $0.ownerRepo }.joined(separator: ", "))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .help("\(session.state.displayName) · \(session.meta.primaryRepo?.branch ?? "")")
    }
}

private struct StateDot: View {
    let state: SessionState

    var body: some View {
        Circle()
            .fill(colour)
            .frame(width: 8, height: 8)
            .opacity(opacity)
            .overlay(
                Circle()
                    .stroke(.separator, lineWidth: 0.5)
            )
    }

    private var colour: Color {
        switch state {
        case .awaitingInput: .yellow
        case .working, .starting: .blue
        case .idle: .secondary
        case .done: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }

    private var opacity: Double {
        switch state {
        case .idle, .stopped, .done: 0.55
        default: 1.0
        }
    }
}
