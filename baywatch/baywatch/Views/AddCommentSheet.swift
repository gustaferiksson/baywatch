//
//  AddCommentSheet.swift
//  baywatch
//
//  Modal sheet that pops when the user clicks a line in the diff. Shows the
//  line snippet for context, takes a comment body, and persists into the
//  CommentStore.
//

import SwiftUI

struct AddCommentSheet: View {
    let pending: PendingComment
    @Environment(CommentStore.self) private var commentStore
    @Environment(\.dismiss) private var dismiss
    @State private var commentBody: String = ""
    @FocusState private var bodyFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("\(pending.file):\(pending.line)")
                        .font(.system(.caption, design: .monospaced).weight(.medium))
                }
                Text(pending.snippet.isEmpty ? " " : pending.snippet)
                    .font(.system(.body, design: .monospaced))
                    .padding(8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 4))
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(.separator, lineWidth: 0.5))
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Comment")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                TextEditor(text: $commentBody)
                    .focused($bodyFocused)
                    .font(.body)
                    .frame(minHeight: 100)
                    .padding(6)
                    .overlay(RoundedRectangle(cornerRadius: 4).stroke(.separator, lineWidth: 0.5))
            }

            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Add Comment") { add() }
                    .keyboardShortcut(.return, modifiers: [.command])
                    .buttonStyle(.borderedProminent)
                    .disabled(commentBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 460, minHeight: 280)
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
