//
//  FileEditorView.swift
//  baywatch
//
//  Phase 2, increment 2: in-app editor backed by CodeEditSourceEditor
//  (Tree-sitter syntax highlighting + line numbers). Language is detected from
//  the file path; the theme follows the app's light/dark appearance. Edits land
//  in the session's clone, which is identity-mounted into the container — so the
//  agent sees them live and they fetch back with everything else.
//

import SwiftUI
import AppKit
import CodeEditSourceEditor
import CodeEditLanguages

/// A file the user has opened for editing (wrapper so `.sheet(item:)` works).
struct EditingFile: Identifiable {
    let id = UUID()
    let path: String
}

/// Thin wrapper over CodeEditSourceEditor's `SourceEditor`, wired for a single
/// file: language from the path, theme from the color scheme.
private struct CodeEditor: View {
    let path: String
    @Binding var text: String
    @Environment(\.colorScheme) private var colorScheme
    @AppStorage(AppSettings.fontNameKey) private var fontName = AppSettings.fontNameDefault
    @AppStorage(AppSettings.fontSizeKey) private var fontSize = AppSettings.fontSizeDefault
    @State private var editorState = SourceEditorState()

    var body: some View {
        SourceEditor(
            $text,
            language: CodeLanguage.detectLanguageFrom(url: URL(fileURLWithPath: path)),
            configuration: SourceEditorConfiguration(
                appearance: .init(
                    theme: colorScheme == .dark ? .baywatchDark : .baywatchLight,
                    font: AppSettings.monospaceFont(name: fontName, size: fontSize),
                    wrapLines: false,
                    tabWidth: 4
                )
            ),
            state: $editorState
        )
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
                CodeEditor(path: path, text: $text)
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
        .frame(width: 900, height: 640)
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

// MARK: - Theme

private func hexColor(_ value: String) -> NSColor {
    var string = value
    if string.hasPrefix("#") { string.removeFirst() }
    var rgb: UInt64 = 0
    Scanner(string: string).scanHexInt64(&rgb)
    return NSColor(
        srgbRed: CGFloat((rgb & 0xFF0000) >> 16) / 255,
        green: CGFloat((rgb & 0x00FF00) >> 8) / 255,
        blue: CGFloat(rgb & 0x0000FF) / 255,
        alpha: 1
    )
}

// Xcode-flavored light/dark themes (adapted from CodeEditSourceEditor's example).
extension EditorTheme {
    static var baywatchLight: EditorTheme {
        EditorTheme(
            text: Attribute(color: hexColor("000000")),
            insertionPoint: hexColor("000000"),
            invisibles: Attribute(color: hexColor("D6D6D6")),
            background: hexColor("FFFFFF"),
            lineHighlight: hexColor("ECF5FF"),
            selection: hexColor("B2D7FF"),
            keywords: Attribute(color: hexColor("9B2393"), bold: true),
            commands: Attribute(color: hexColor("326D74")),
            types: Attribute(color: hexColor("0B4F79")),
            attributes: Attribute(color: hexColor("815F03")),
            variables: Attribute(color: hexColor("0F68A0")),
            values: Attribute(color: hexColor("6C36A9")),
            numbers: Attribute(color: hexColor("1C00CF")),
            strings: Attribute(color: hexColor("C41A16")),
            characters: Attribute(color: hexColor("1C00CF")),
            comments: Attribute(color: hexColor("267507"))
        )
    }

    static var baywatchDark: EditorTheme {
        EditorTheme(
            text: Attribute(color: hexColor("FFFFFF")),
            insertionPoint: hexColor("007AFF"),
            invisibles: Attribute(color: hexColor("53606E")),
            background: hexColor("292A30"),
            lineHighlight: hexColor("2F3239"),
            selection: hexColor("646F83"),
            keywords: Attribute(color: hexColor("FF7AB2"), bold: true),
            commands: Attribute(color: hexColor("78C2B3")),
            types: Attribute(color: hexColor("6BDFFF")),
            attributes: Attribute(color: hexColor("CC9768")),
            variables: Attribute(color: hexColor("4EB0CC")),
            values: Attribute(color: hexColor("B281EB")),
            numbers: Attribute(color: hexColor("D9C97C")),
            strings: Attribute(color: hexColor("FF8170")),
            characters: Attribute(color: hexColor("D9C97C")),
            comments: Attribute(color: hexColor("7F8C98"))
        )
    }
}
