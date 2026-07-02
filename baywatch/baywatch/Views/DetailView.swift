//
//  DetailView.swift
//  baywatch
//
//  Detail pane orchestrator. Header on top, diff + comments split below.
//  Embedded terminal lands here in task #15.
//

import SwiftUI
import AppKit

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
                VStack(spacing: 0) {
                    LandingStrip(session: session)
                    Divider()
                    VSplitView {
                        diffSection(session: session)
                            .frame(minHeight: 160, idealHeight: 380)
                        CommentsPanel(session: session)
                            .frame(minHeight: 120, idealHeight: 160)
                    }
                }
                .inspectorColumnWidth(min: 300, ideal: 380, max: 580)
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

/// Per-repo landing actions for a session's task: push the branch, open a PR,
/// open the clone in an editor, and show the PR's check rollup.
private struct LandingStrip: View {
    let session: Session
    @State private var statuses: [String: PRStatus] = [:]
    @State private var busy: Set<String> = []
    @State private var error: String?

    var body: some View {
        VStack(spacing: 0) {
            ForEach(session.meta.repos, id: \.clonePath) { repo in
                row(repo)
                if repo.clonePath != session.meta.repos.last?.clonePath { Divider() }
            }
            if let error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
            }
        }
        .task(id: session.id) { await refreshStatuses() }
    }

    private func row(_ repo: SessionRepo) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Text(repo.ownerRepo)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                Text(repo.branch)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 4)
            if let status = statuses[repo.ownerRepo] {
                PRStatusBadge(status: status)
            }
            if busy.contains(repo.ownerRepo) {
                ProgressView().controlSize(.small)
            } else {
                Button { Task { await push(repo) } } label: {
                    Image(systemName: "arrow.up.circle")
                }
                .buttonStyle(.borderless)
                .help("Land + push \(repo.branch) to origin")
                Button { openPR(repo) } label: {
                    Image(systemName: "arrow.triangle.pull")
                }
                .buttonStyle(.borderless)
                .help("Create a pull request on GitHub")
                Button { openEditor(repo) } label: {
                    Image(systemName: "chevron.left.forwardslash.chevron.right")
                }
                .buttonStyle(.borderless)
                .help("Open this clone in your editor")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func refreshStatuses() async {
        for repo in session.meta.repos {
            let owner = repo.ownerRepo
            let branch = repo.branch
            let status = await Task.detached { GitService.prStatus(ownerRepo: owner, branch: branch) }.value
            statuses[owner] = status
        }
    }

    private func push(_ repo: SessionRepo) async {
        let owner = repo.ownerRepo
        let clonePath = repo.clonePath
        let mainClonePath = repo.mainClonePath
        let branch = repo.branch
        busy.insert(owner)
        defer { busy.remove(owner) }
        error = nil
        let result = await Task.detached {
            GitService.landAndPush(clonePath: clonePath, mainClonePath: mainClonePath, branch: branch)
        }.value
        if !result.ok {
            error = result.message.isEmpty ? "push failed" : result.message
            return
        }
        statuses[owner] = await Task.detached { GitService.prStatus(ownerRepo: owner, branch: branch) }.value
    }

    private func openPR(_ repo: SessionRepo) {
        let owner = repo.ownerRepo
        let branch = repo.branch
        Task.detached { GitService.createPRWeb(ownerRepo: owner, branch: branch) }
    }

    private func openEditor(_ repo: SessionRepo) {
        let path = repo.clonePath
        Task.detached { GitService.openInEditor(path: path) }
    }
}

private struct PRStatusBadge: View {
    let status: PRStatus

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.caption2)
            Text("#\(status.number)").font(.caption2.monospaced())
        }
        .foregroundStyle(color)
        .help("PR #\(status.number) · \(status.state.lowercased()) · \(rollupLabel) checks")
        .onTapGesture {
            if let url = URL(string: status.url) { NSWorkspace.shared.open(url) }
        }
    }

    private var icon: String {
        switch status.rollup {
        case .passing: "checkmark.circle.fill"
        case .failing: "xmark.octagon.fill"
        case .pending: "clock.fill"
        case .none: "circle"
        }
    }

    private var color: Color {
        switch status.rollup {
        case .passing: .green
        case .failing: .red
        case .pending: .yellow
        case .none: .secondary
        }
    }

    private var rollupLabel: String {
        switch status.rollup {
        case .passing: "passing"
        case .failing: "failing"
        case .pending: "pending"
        case .none: "no"
        }
    }
}
