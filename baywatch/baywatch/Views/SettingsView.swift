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

    var body: some View {
        TabView {
            generalTab
                .tabItem {
                    Label("General", systemImage: "gearshape")
                }
        }
        .frame(width: 520, height: 280)
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
