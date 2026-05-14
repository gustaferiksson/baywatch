//
//  CommentsPanel.swift
//  baywatch
//
//  Bottom panel showing pending review comments for the current session,
//  plus the "Send to Session" action that packages them up and pushes them
//  into the running claude session via the tmux bridge.
//

import SwiftUI

struct CommentsPanel: View {
    let session: Session
    @Environment(CommentStore.self) private var commentStore
    @State private var isSending = false
    @State private var sendError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if commentStore.comments.isEmpty {
                emptyState
            } else {
                list
            }
        }
        .background(.background)
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Comments")
                .font(.callout.weight(.semibold))
                .lineLimit(1)
            Text("(\(commentStore.comments.count))")
                .font(.callout)
                .foregroundStyle(.tertiary)
                .monospacedDigit()
            Spacer(minLength: 8)
            Button("Clear") { commentStore.clear() }
                .buttonStyle(.borderless)
                .disabled(commentStore.comments.isEmpty)
            Button {
                Task { await send() }
            } label: {
                Label("Send", systemImage: "paperplane.fill")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.borderedProminent)
            .disabled(commentStore.comments.isEmpty || isSending)
            .keyboardShortcut(.return, modifiers: [.command])
            .help("Send pending comments to the session (⌘↩)")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Text("No comments yet")
                .font(.callout)
                .foregroundStyle(.secondary)
            Text("Click any line in the diff to comment.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(commentStore.comments) { comment in
                    row(for: comment)
                }
            }
            .padding(16)
        }
    }

    private func row(for comment: Comment) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text("\(comment.file):\(comment.line)")
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .textSelection(.enabled)
                Spacer(minLength: 4)
                Button {
                    commentStore.remove(comment)
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.tertiary)
                }
                .buttonStyle(.plain)
                .help("Remove comment")
            }
            Text(comment.snippet.isEmpty ? " " : comment.snippet)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.background.secondary, in: RoundedRectangle(cornerRadius: 4))
            Text(comment.body)
                .font(.callout)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(10)
        .background(.background.tertiary, in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator, lineWidth: 0.5))
    }

    private func send() async {
        guard !commentStore.comments.isEmpty else { return }
        isSending = true
        defer { isSending = false }

        let message = formatMessage(commentStore.comments)
        let ok = TmuxBridge.send(containerName: session.meta.containerName, message: message)
        if ok {
            commentStore.clear()
            sendError = nil
        } else {
            sendError = "Failed to send to session container \(session.meta.containerName)."
        }
    }

    private func formatMessage(_ comments: [Comment]) -> String {
        var out = "[Review feedback]\n"
        for c in comments {
            out += "\n\(c.file):\(c.line)\n"
            out += "> \(c.snippet)\n"
            out += "\(c.body)\n"
        }
        out += "\nPlease address these and confirm when ready."
        return out
    }
}
