//
//  NewSessionSheet.swift
//  baywatch
//
//  Keyboard-first session creator. Search field at top, filtered flat list of
//  git repos below. Arrows navigate, Tab toggles a repo into the selection
//  (multi-repo task), Return creates, Escape cancels. With nothing explicitly
//  selected, Return creates a single-repo session from the highlighted row.
//

import SwiftUI
import AppKit

struct NewSessionSheet: View {
    var onCreated: (String) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss
    @Environment(SessionStore.self) private var store
    @AppStorage(AppSettings.reposRootKey) private var reposRootPath = AppSettings.reposRootDefault

    @State private var repos: [String] = []
    @State private var search: String = ""
    @State private var selected: Set<String> = []
    @State private var highlightedIndex: Int = 0
    @State private var isCreating: Bool = false
    @State private var errorMessage: String?
    @State private var sessionName: String = ""
    @FocusState private var focus: Field?

    private enum Field { case name, search }

    private var filteredRepos: [String] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return repos }
        return repos.filter { $0.lowercased().contains(q) }
    }

    private var highlightedRepo: String? {
        let list = filteredRepos
        guard !list.isEmpty else { return nil }
        let index = min(max(0, highlightedIndex), list.count - 1)
        return list[index]
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            nameField
            Divider()
            searchField
            Divider()
            selectedStrip
            list
            if let errorMessage { errorBanner(errorMessage) }
            footer
        }
        .frame(width: 520, height: 500)
        .background(createShortcut)
        .task(id: reposRootPath) { rediscover() }
        .onChange(of: search) { _, _ in highlightedIndex = 0 }
        .onAppear { focus = .search }
    }

    // ⌘↩ from anywhere in the sheet (incl. the name field) creates the session.
    private var createShortcut: some View {
        Button("Create Session") { Task { await performCreate() } }
            .keyboardShortcut(.return, modifiers: [.command])
            .opacity(0)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
    }

    private var nameField: some View {
        HStack(spacing: 10) {
            Image(systemName: "pencil.line")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
            TextField("Session name (optional — auto-generated if blank)", text: $sessionName)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($focus, equals: .name)
                .onKeyPress(.escape) {
                    if !isCreating { dismiss() }
                    return .handled
                }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var searchField: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
                .foregroundStyle(.secondary)
            TextField("Search repos…", text: $search)
                .textFieldStyle(.plain)
                .font(.title3)
                .focused($focus, equals: .search)
                .onKeyPress(.upArrow) { moveHighlight(-1); return .handled }
                .onKeyPress(.downArrow) { moveHighlight(1); return .handled }
                .onKeyPress(.tab) { toggleHighlighted(); return .handled }
                .onKeyPress(keys: [.return]) { press in
                    // ⌘↩ falls through to the Create shortcut; plain ↩ selects.
                    if press.modifiers.contains(.command) { return .ignored }
                    toggleHighlighted()
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

    // Always rendered (fixed height) so the list doesn't jump when the first
    // repo is selected; shows a hint when empty.
    private var selectedStrip: some View {
        Group {
            if selected.isEmpty {
                HStack {
                    Text("Selected repos appear here — ↩ to add · ⌘↩ to create")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 14)
            } else {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(selected.sorted(), id: \.self) { repo in
                            HStack(spacing: 4) {
                                Text(repo).font(.caption.monospaced())
                                Image(systemName: "xmark.circle.fill")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                    .onTapGesture { selected.remove(repo) }
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                        }
                    }
                    .padding(.horizontal, 14)
                }
            }
        }
        .frame(height: 36)
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
                                    toggleHighlighted()
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
        let isSelected = selected.contains(repo)
        return HStack(spacing: 10) {
            Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                .foregroundStyle(isHighlighted ? Color.white : (isSelected ? Color.accentColor : Color.secondary.opacity(0.4)))
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
                Spacer(minLength: 6)
                Text(selected.isEmpty ? "↑↓ navigate · ↩ select · ⌘↩ create · esc cancel"
                                       : "⌘↩ create \(selected.count) · ↩ toggle · esc cancel")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
    }

    private func errorBanner(_ message: String) -> some View {
        HStack(alignment: .top, spacing: 6) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            ScrollView {
                Text(message)
                    .font(.caption.monospaced())
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 96)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.red.opacity(0.08))
        .overlay(Divider(), alignment: .top)
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

    private func toggleHighlighted() {
        guard let repo = highlightedRepo else { return }
        if selected.contains(repo) {
            selected.remove(repo)
        } else {
            selected.insert(repo)
        }
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
        var repos = selected.sorted()
        if repos.isEmpty, let highlighted = highlightedRepo {
            repos = [highlighted]
        }
        guard !repos.isEmpty, !isCreating else { return }
        let trimmedName = sessionName.trimmingCharacters(in: .whitespacesAndNewlines)
        errorMessage = nil
        isCreating = true
        defer { isCreating = false }

        do {
            let id = try await SessionActions.create(repos: repos, name: trimmedName.isEmpty ? nil : trimmedName)
            store.refresh()
            onCreated(id)
            dismiss()
        } catch let failure as SessionActions.Failure {
            errorMessage = failure.message
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
