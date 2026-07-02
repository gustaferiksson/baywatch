//
//  SettingsView.swift
//  baywatch
//
//  Standard macOS Settings window (App menu → Settings…, or ⌘,). Single
//  General pane for now — repos root path.
//

import SwiftUI
import AppKit

/// Stored in UserDefaults; read by NewSessionSheet's RepoBrowser.
enum AppSettings {
    static let reposRootKey = "reposRootPath"
    static let reposRootDefault = "\(NSHomeDirectory())/Repos"
    static let terminalAppKey = "preferredTerminalApp"

    static let fontNameKey = "monospaceFontName"
    static let fontNameDefault = "Menlo"
    static let fontSizeKey = "monospaceFontSize"
    static let fontSizeDefault = 13.0

    /// The chosen monospaced font, falling back to the system monospaced font
    /// when the named family isn't installed.
    static func monospaceFont(name: String, size: Double) -> NSFont {
        NSFont(name: name, size: size) ?? .monospacedSystemFont(ofSize: size, weight: .regular)
    }

    /// Monospaced font families installed on this machine (for the picker).
    static let availableMonospaceFamilies: [String] = {
        NSFontManager.shared.availableFontFamilies
            .filter { NSFont(name: $0, size: 12)?.isFixedPitch == true }
            .sorted()
    }()
}

enum TerminalApp: String, CaseIterable, Identifiable {
    case system = "Terminal"
    case iterm = "iTerm"
    case ghostty = "Ghostty"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .system: "Terminal"
        case .iterm: "iTerm2"
        case .ghostty: "Ghostty"
        }
    }
}

struct SettingsView: View {
    @AppStorage(AppSettings.reposRootKey) private var reposRootPath = AppSettings.reposRootDefault
    @AppStorage(AppSettings.terminalAppKey) private var terminalAppRaw = TerminalApp.system.rawValue
    @AppStorage(AppSettings.fontNameKey) private var fontName = AppSettings.fontNameDefault
    @AppStorage(AppSettings.fontSizeKey) private var fontSize = AppSettings.fontSizeDefault

    var body: some View {
        TabView {
            generalTab
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }
        }
        .frame(width: 520, height: 440)
    }

    private var generalTab: some View {
        Form {
            Section {
                LabeledContent("Repos folder") {
                    HStack(spacing: 8) {
                        Text(reposRootPath)
                            .font(.body)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Choose…") { chooseRoot() }
                    }
                }
            } footer: {
                Text("baywatch scans this folder (up to 4 levels deep) for git repos when creating a new session. Default is ~/Repos to match the CLI's `cloneRoots` convention.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Terminal app", selection: $terminalAppRaw) {
                    ForEach(TerminalApp.allCases) { app in
                        Text(app.displayName).tag(app.rawValue)
                    }
                }
                .pickerStyle(.menu)
            } footer: {
                Text("Used by the “Attach in Terminal” action. Defaults to macOS Terminal.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Section {
                Picker("Font", selection: $fontName) {
                    ForEach(AppSettings.availableMonospaceFamilies, id: \.self) { family in
                        Text(family).font(.custom(family, size: 13)).tag(family)
                    }
                }
                .pickerStyle(.menu)
                Stepper(value: $fontSize, in: 9...28, step: 1) {
                    LabeledContent("Size", value: "\(Int(fontSize)) pt")
                }
                LabeledContent("Preview") {
                    Text("fn main() { 0xABC }")
                        .font(.custom(fontName, size: fontSize))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } header: {
                Text("Editor & terminal font")
            } footer: {
                Text("Monospaced font for the in-app editor and the session terminal. New terminals pick it up immediately; the editor updates live.")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .formStyle(.grouped)
    }

    private func chooseRoot() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: reposRootPath)
        panel.prompt = "Choose"
        panel.message = "Pick the folder that contains your git repos."

        if panel.runModal() == .OK, let url = panel.url {
            reposRootPath = url.path
        }
    }
}
