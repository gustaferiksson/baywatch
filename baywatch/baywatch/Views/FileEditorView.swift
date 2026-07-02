//
//  FileEditorView.swift
//  baywatch
//
//  Phase 2, increment 1: a minimal native in-app file editor. Edits land in the
//  session's clone, which is identity-mounted into the container — so the agent
//  sees your edits live and they fetch back with everything else. No syntax
//  highlighting yet; that arrives with CodeEditSourceEditor + Tree-sitter.
//

import SwiftUI
import AppKit

/// A file the user has opened for editing (wrapper so `.sheet(item:)` works).
struct EditingFile: Identifiable {
    let id = UUID()
    let path: String
}

/// NSTextView-backed plain-text editor bound to a String. Monospaced, no rich
/// text / auto-substitutions, undo enabled, non-wrapping (horizontal scroll).
struct FileEditorView: NSViewRepresentable {
    @Binding var text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSTextView.scrollableTextView()
        scroll.hasHorizontalScroller = true
        guard let textView = scroll.documentView as? NSTextView else { return scroll }
        textView.delegate = context.coordinator
        textView.isRichText = false
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticSpellingCorrectionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.allowsUndo = true
        textView.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textContainerInset = NSSize(width: 6, height: 8)
        textView.isHorizontallyResizable = true
        textView.textContainer?.widthTracksTextView = false
        textView.textContainer?.containerSize = NSSize(
            width: CGFloat.greatestFiniteMagnitude,
            height: CGFloat.greatestFiniteMagnitude
        )
        textView.string = text
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let textView = scroll.documentView as? NSTextView else { return }
        // Only re-set when the binding changed from outside the editor. Edits
        // made in the view set text == string already, so this never fires on
        // the user's own typing (no cursor jump).
        if textView.string != text {
            textView.string = text
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        private let text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textDidChange(_ notification: Notification) {
            guard let textView = notification.object as? NSTextView else { return }
            text.wrappedValue = textView.string
        }
    }
}

/// Sheet wrapper: loads the file, hosts the editor, saves on ⌘S. Save writes
/// straight to the clone on disk.
struct FileEditorSheet: View {
    let path: String
    @Environment(\.dismiss) private var dismiss
    @State private var text: String = ""
    @State private var original: String = ""
    @State private var loadError: String?
    @State private var saveError: String?

    private var dirty: Bool { text != original }
    private var filename: String { URL(fileURLWithPath: path).lastPathComponent }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text")
                    .foregroundStyle(.secondary)
                Text(filename)
                    .font(.headline)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if dirty {
                    Text("• edited")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button("Save") { save() }
                    .keyboardShortcut("s", modifiers: [.command])
                    .disabled(!dirty || loadError != nil)
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(10)
            Divider()
            if let loadError {
                ContentUnavailableView(
                    "Can't open file",
                    systemImage: "exclamationmark.triangle",
                    description: Text(loadError)
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                FileEditorView(text: $text)
            }
            if let saveError {
                Text(saveError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
            }
        }
        .frame(width: 820, height: 620)
        .onAppear(perform: load)
    }

    private func load() {
        do {
            let content = try String(contentsOfFile: path, encoding: .utf8)
            text = content
            original = content
            loadError = nil
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func save() {
        do {
            try text.write(toFile: path, atomically: true, encoding: .utf8)
            original = text
            saveError = nil
        } catch {
            saveError = "Save failed: \(error.localizedDescription)"
        }
    }
}
