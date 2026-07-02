//
//  DetailHeader.swift
//  baywatch
//
//  Title block at the top of the detail pane: session name + repo + branch +
//  state pill + actions (attach in terminal, open in claude.ai/code).
//

import SwiftUI
import AppKit

struct DetailHeader: View {
    let session: Session
    @Environment(SessionStore.self) private var store
    @State private var pendingRemove = false
    @State private var actionError: String?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(session.meta.name)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)
                    .truncationMode(.tail)
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(session.meta.repos.map { $0.ownerRepo }.joined(separator: ", "))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Text("·")
                        .font(.subheadline)
                        .foregroundStyle(.tertiary)
                    Image(systemName: "arrow.triangle.branch")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(session.meta.primaryRepo?.branch ?? "—")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                .layoutPriority(0)
            }
            .layoutPriority(1)
            Spacer(minLength: 8)
            statePill
                .layoutPriority(2)
            actions
                .layoutPriority(2)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .confirmationDialog(
            "Remove this session?",
            isPresented: $pendingRemove
        ) {
            Button("Remove “\(session.meta.name)”", role: .destructive) {
                performRemove()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
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

    private func performStop() {
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

    private func performRemove() {
        Task {
            do {
                try await SessionActions.remove(sessionId: session.id)
                store.refresh()
            } catch let failure as SessionActions.Failure {
                actionError = failure.message
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private var statePill: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(stateColour)
                .frame(width: 8, height: 8)
            Text(session.state.displayName)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.regularMaterial, in: Capsule())
        .overlay(Capsule().stroke(.separator, lineWidth: 0.5))
    }

    private var stateColour: Color {
        switch session.state {
        case .awaitingInput: .yellow
        case .working, .starting: .blue
        case .idle: .secondary
        case .done: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }

    private var actions: some View {
        HStack(spacing: 4) {
            Button {
                openClaudeWeb()
            } label: {
                Image(systemName: "safari")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.borderless)
            .help("Open in claude.ai/code")
            .disabled(session.meta.rcEnvironmentUrl == nil)

            Button {
                TerminalLauncher.attachToSession(containerName: session.meta.containerName)
            } label: {
                Image(systemName: "terminal")
                    .frame(width: 30, height: 30)
            }
            .buttonStyle(.borderless)
            .help("Attach in Terminal (podman exec tmux attach)")

            Menu {
                Button {
                    performStop()
                } label: {
                    Label("Stop Session", systemImage: "stop.circle")
                }
                .disabled(session.state == .stopped || session.state == .done)
                Button(role: .destructive) {
                    pendingRemove = true
                } label: {
                    Label("Remove Session…", systemImage: "trash")
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .frame(width: 30, height: 30)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .help("More actions")
        }
        .font(.title2)
        .foregroundStyle(.secondary)
    }

    private func openClaudeWeb() {
        guard let url = session.meta.rcEnvironmentUrl.flatMap(URL.init(string:)) else { return }
        NSWorkspace.shared.open(url)
    }

}
