//
//  DetailView.swift
//  baywatch
//
//  Detail pane orchestrator. Header on top, diff + comments split below.
//  Embedded terminal lands here in task #15.
//

import SwiftUI

/// Wraps the SwiftTerm-backed terminal in the styled padded container, and is
/// itself Equatable on containerName so SwiftUI skips the whole subtree (incl.
/// the .padding/.background chain) when only unrelated parent state changed.
private struct TerminalPane: View, Equatable {
    let containerName: String

    static func == (lhs: TerminalPane, rhs: TerminalPane) -> Bool {
        lhs.containerName == rhs.containerName
    }

    var body: some View {
        SessionTerminalView(containerName: containerName)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(10)
            .background(Color.black)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 0.5))
            .padding(10)
    }
}

struct DetailView: View {
    let session: Session?
    @Environment(DiffStore.self) private var diffStore
    @Environment(CommentStore.self) private var commentStore
    @State private var pendingComment: PendingComment?
    @AppStorage("showReviewInspector") private var showInspector: Bool = true

    var body: some View {
        if let session {
            VStack(spacing: 0) {
                DetailHeader(session: session)
                Divider()
                TerminalPane(containerName: session.meta.containerName)
                    .equatable()
                    .id(session.id)
            }
            .task(id: session.id) {
                diffStore.load(session: session)
                commentStore.load(sessionId: session.id)
            }
            .inspector(isPresented: $showInspector) {
                VSplitView {
                    diffSection(session: session)
                        .frame(minHeight: 160, idealHeight: 380)
                    CommentsPanel(session: session)
                        .frame(minHeight: 120, idealHeight: 160)
                }
                .inspectorColumnWidth(min: 280, ideal: 360, max: 560)
            }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        diffStore.refresh(session: session)
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .help("Refresh diff")
                    .disabled(!showInspector)
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        showInspector.toggle()
                    } label: {
                        Image(systemName: "sidebar.right")
                    }
                    .help(showInspector ? "Hide review panel" : "Show review panel")
                    .keyboardShortcut("0", modifiers: [.command, .option])
                }
            }
        } else {
            ContentUnavailableView("Select a session", systemImage: "sidebar.left")
        }
    }

    @ViewBuilder
    private func diffSection(session: Session) -> some View {
        if diffStore.isLoading && diffStore.diff.isEmpty {
            VStack(spacing: 10) {
                ProgressView()
                Text("Loading diff…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            DiffView(diff: diffStore.diff, commentOnLine: $pendingComment)
        }
    }
}
