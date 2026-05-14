//
//  AddCommentPopover.swift
//  baywatch
//
//  Lightweight popover for adding an inline review comment. Anchored to the
//  diff line that was clicked — feels closer to GitHub's inline-comment UX
//  than a full-blown modal sheet.
//

import SwiftUI

struct AddCommentPopover: View {
    let pending: PendingComment
    @Environment(CommentStore.self) private var commentStore
    @Environment(\.dismiss) private var dismiss
    @State private var commentBody: String = ""
    @FocusState private var bodyFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(pending.file):\(pending.line)")
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Text(pending.snippet.isEmpty ? " " : pending.snippet)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .padding(6)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 4))

            TextEditor(text: $commentBody)
                .focused($bodyFocused)
                .font(.body)
                .frame(minHeight: 80, maxHeight: 200)
                .padding(4)
                .overlay(RoundedRectangle(cornerRadius: 4).stroke(.separator, lineWidth: 0.5))

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Add") { add() }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .buttonStyle(.borderedProminent)
                    .disabled(commentBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(14)
        .frame(width: 380)
        .onAppear { bodyFocused = true }
    }

    private func add() {
        let trimmed = commentBody.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        commentStore.add(Comment(
            file: pending.file,
            line: pending.line,
            snippet: pending.snippet,
            body: trimmed
        ))
        dismiss()
    }
}
