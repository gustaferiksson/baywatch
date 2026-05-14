//
//  NewSessionSheet.swift
//  baywatch
//
//  Keyboard-first session creator. Single search field at top, filtered flat
//  list of git repos below. Arrows navigate, Return creates, Escape cancels.
//  Session name is auto-generated; rename in-place later if needed.
//

import SwiftUI
import AppKit

struct NewSessionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var store
    @AppStorage(AppSettings.reposRootKey) private var reposRootPath = AppSettings.reposRootDefault

    @State private var repos: [String] = []
    @State private var search: String = ""
    @State private var highlightedIndex: Int = 0
    @State private var isCreating: Bool = false
    @State private var errorMessage: String?
    @FocusState private var searchFocused: Bool

    private var filteredRepos: [String] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return repos }
        return repos.filter { $0.lowercased().contains(q) }
    }

    private var selectedRepo: String? {
        let list = filteredRepos
        guard !list.isEmpty else { return nil }
        let index = min(max(0, highlightedIndex), list.count - 1)
        return list[index]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            searchField
            Divider()
            list
            footer
        }
        .frame(width: 520, height: 440)
        .task(id: reposRootPath) { rediscover() }
        .onChange(of: search) { _, _ in highlightedIndex = 0 }
        .onAppear { searchFocused = true }
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
            TextField("Search repos…", text: $search)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($searchFocused)
                .onKeyPress(.upArrow) { moveHighlight(-1); return .handled }
                .onKeyPress(.downArrow) { moveHighlight(1); return .handled }
                .onKeyPress(.return) {
                    Task { await performCreate() }
                    return .handled
                }
                .onKeyPress(.escape) {
                    if !isCreating { dismiss() }
                    return .handled
                }
            if isCreating {
                ProgressView().controlSize(.small)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var list: some View {
        ScrollViewReader { scrollProxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if filteredRepos.isEmpty {
                        emptyState
                    } else {
                        ForEach(Array(filteredRepos.enumerated()), id: \.element) { index, repo in
                            row(repo, isHighlighted: index == highlightedIndex)
                                .id(repo)
                                .onTapGesture {
                                    highlightedIndex = index
                                    Task { await performCreate() }
                                }
                        }
                    }
                }
            }
            .onChange(of: highlightedIndex) { _, newValue in
                let list = filteredRepos
                guard list.indices.contains(newValue) else { return }
                withAnimation(.easeOut(duration: 0.12)) {
                    scrollProxy.scrollTo(list[newValue], anchor: .center)
                }
            }
        }
        .frame(maxHeight: .infinity)
    }

    private func row(_ repo: String, isHighlighted: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "arrow.triangle.branch")
                .foregroundStyle(isHighlighted ? Color.white : Color.accentColor)
            Text(repo)
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(isHighlighted ? Color.white : Color.primary)
            Spacer(minLength: 0)
            if isHighlighted {
                Text("↩")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white.opacity(0.7))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 7)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isHighlighted ? Color.accentColor : Color.clear)
        .contentShape(Rectangle())
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "folder.badge.questionmark")
                .font(.title2)
                .foregroundStyle(.secondary)
            Text(repos.isEmpty ? "No git repos under \(displayRoot)" : "No matches for “\(search)”")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private var footer: some View {
        VStack(spacing: 0) {
            Divider()
            HStack(spacing: 6) {
                if let errorMessage {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundStyle(.red)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(errorMessage)
                } else {
                    Image(systemName: "folder")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                    Text(displayRoot)
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Button("Change…") { chooseRoot() }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                Spacer(minLength: 6)
                Text("↑↓ navigate · ↩ create · esc cancel")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private var displayRoot: String {
        let home = NSHomeDirectory()
        if reposRootPath.hasPrefix(home) {
            return "~" + reposRootPath.dropFirst(home.count)
        }
        return reposRootPath
    }

    private func moveHighlight(_ delta: Int) {
        let count = filteredRepos.count
        guard count > 0 else { return }
        highlightedIndex = max(0, min(count - 1, highlightedIndex + delta))
    }

    private func rediscover() {
        let root = URL(fileURLWithPath: NSString(string: reposRootPath).expandingTildeInPath)
        let nodes = RepoBrowser.browse(root: root)
        repos = flatten(nodes).sorted()
        if filteredRepos.indices.contains(highlightedIndex) == false {
            highlightedIndex = 0
        }
    }

    /// Walks the tree once at discovery time and emits flat `owner/repo`
    /// identifiers — the picker is intentionally non-hierarchical now.
    private func flatten(_ nodes: [RepoNode]) -> [String] {
        var out: [String] = []
        for node in nodes {
            if node.isGitRepo {
                out.append(RepoBrowser.ownerRepoIdentifier(for: node.path))
            } else if let kids = node.children {
                out.append(contentsOf: flatten(kids))
            }
        }
        return out
    }

    private func chooseRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: NSString(string: reposRootPath).expandingTildeInPath)
        panel.prompt = "Choose"
        if panel.runModal() == .OK, let url = panel.url {
            reposRootPath = url.path
        }
    }

    private func performCreate() async {
        guard let repo = selectedRepo, !isCreating else { return }
        errorMessage = nil
        isCreating = true
        defer { isCreating = false }

        do {
            try await SessionActions.create(repo: repo, name: nil)
            store.refresh()
            dismiss()
        } catch let failure as SessionActions.Failure {
            errorMessage = failure.message
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
