//
//  DiffView.swift
//  baywatch
//
//  Renders the parsed diff with collapsible per-file disclosures, monospaced
//  hunk bodies, and add/delete colouring. Click a line to attach a comment.
//

import SwiftUI

struct DiffView: View {
    let diff: ParsedDiff
    @Binding var commentOnLine: PendingComment?
    @Environment(CommentStore.self) private var commentStore
    @State private var collapsedSet: Set<String> = []

    private func hasComment(file: String, line: Int?) -> Bool {
        guard let line else { return false }
        return commentStore.comments.contains { $0.file == file && $0.line == line }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                ForEach(diff.files) { file in
                    fileBlock(file)
                }
                if diff.isEmpty {
                    emptyState
                }
            }
            .padding(20)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "checkmark.seal")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("No diff yet")
                .font(.headline)
            Text("The agent hasn't changed anything on this branch.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }

    private func fileBlock(_ file: DiffFile) -> some View {
        let isCollapsed = collapsedSet.contains(file.id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                toggle(file.id)
            } label: {
                fileHeader(file, collapsed: isCollapsed)
            }
            .buttonStyle(.plain)

            if !isCollapsed {
                ForEach(file.hunks) { hunk in
                    hunkView(hunk, filePath: file.path)
                        .padding(.top, 8)
                }
            }
        }
        .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(.separator, lineWidth: 0.5))
    }

    private func toggle(_ id: String) {
        if collapsedSet.contains(id) { collapsedSet.remove(id) }
        else { collapsedSet.insert(id) }
    }

    private func fileHeader(_ file: DiffFile, collapsed: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 12)
            statusBadge(file.status)
            Text(file.path)
                .font(.system(.body, design: .monospaced).weight(.medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .textSelection(.enabled)
                .help(file.path)
            if file.status == .renamed, let old = file.oldPath {
                Text("← \(old)")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            Spacer(minLength: 8)
            hunkStats(file)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func statusBadge(_ status: DiffFile.Status) -> some View {
        let (text, colour): (String, Color) = switch status {
        case .added: ("A", .green)
        case .deleted: ("D", .red)
        case .modified: ("M", .blue)
        case .renamed: ("R", .orange)
        }
        return Text(text)
            .font(.caption.weight(.bold))
            .foregroundStyle(colour)
            .frame(width: 18, height: 18)
            .background(colour.opacity(0.15), in: RoundedRectangle(cornerRadius: 4))
    }

    private func hunkStats(_ file: DiffFile) -> some View {
        let additions = file.hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .addition }.count }
        let deletions = file.hunks.reduce(0) { $0 + $1.lines.filter { $0.kind == .deletion }.count }
        return HStack(spacing: 6) {
            Text("+\(additions)")
                .foregroundStyle(.green)
            Text("-\(deletions)")
                .foregroundStyle(.red)
        }
        .font(.caption.monospacedDigit())
    }

    private func hunkView(_ hunk: DiffHunk, filePath: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(hunk.header)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 14)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary)

            ForEach(hunk.lines) { line in
                lineView(line, filePath: filePath)
            }
        }
    }

    private func lineView(_ line: DiffLine, filePath: String) -> some View {
        let displayLine = line.newLineNumber ?? line.oldLineNumber
        let commented = hasComment(file: filePath, line: displayLine)
        // Per-line popover binding: true exactly when commentOnLine targets
        // this (file, line). Clearing dismisses.
        let isCommenting = Binding<Bool>(
            get: {
                guard let pending = commentOnLine, let displayLine else { return false }
                return pending.file == filePath && pending.line == displayLine
            },
            set: { newValue in
                if !newValue { commentOnLine = nil }
            }
        )

        return HStack(alignment: .top, spacing: 0) {
            commentBadge(commented: commented)
            lineNumber(line.oldLineNumber)
            lineNumber(line.newLineNumber)
            marker(for: line.kind)
            Text(line.content.isEmpty ? " " : line.content)
                .font(.system(.body, design: .monospaced))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, 4)
                .padding(.trailing, 14)
                .padding(.vertical, 1)
                .textSelection(.enabled)
                .help(line.content.count > 80 ? line.content : "")
        }
        .background(rowColour(for: line.kind))
        .contentShape(Rectangle())
        .onTapGesture {
            guard let displayLine else { return }
            commentOnLine = PendingComment(file: filePath, line: displayLine, snippet: line.content)
        }
        .popover(isPresented: isCommenting, arrowEdge: .trailing) {
            if let pending = commentOnLine {
                AddCommentPopover(pending: pending)
            }
        }
    }

    /// Always reserves the same horizontal width so the leading edge of line
    /// numbers stays aligned across commented and uncommented rows. Renders
    /// the bubble glyph only when a comment exists for this line.
    private func commentBadge(commented: Bool) -> some View {
        Image(systemName: "bubble.left.fill")
            .font(.system(size: 9))
            .foregroundStyle(commented ? Color.accentColor : Color.clear)
            .frame(width: 14)
    }

    private func lineNumber(_ n: Int?) -> some View {
        Text(n.map(String.init) ?? "")
            .font(.system(.caption2, design: .monospaced))
            .foregroundStyle(.tertiary)
            .frame(width: 34, alignment: .trailing)
            .padding(.trailing, 4)
    }

    private func marker(for kind: DiffLine.Kind) -> some View {
        let char: String = switch kind {
        case .addition: "+"
        case .deletion: "-"
        case .context: " "
        }
        let colour: Color = switch kind {
        case .addition: .green
        case .deletion: .red
        case .context: .secondary
        }
        return Text(char)
            .font(.system(.body, design: .monospaced).weight(.semibold))
            .foregroundStyle(colour)
            .frame(width: 16)
    }

    private func rowColour(for kind: DiffLine.Kind) -> Color {
        switch kind {
        case .addition: Color.green.opacity(0.10)
        case .deletion: Color.red.opacity(0.10)
        case .context: Color.clear
        }
    }
}

/// Transient struct used to drive the "add comment" sheet from a clicked line.
struct PendingComment: Identifiable {
    var id: String { "\(file):\(line)" }
    let file: String
    let line: Int
    let snippet: String
}
