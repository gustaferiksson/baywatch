//
//  ContentView.swift
//  baywatch
//
//  Two-column NavigationSplitView shell. Sidebar lists sessions, detail
//  renders the picked one. macOS picks up the appropriate Liquid Glass chrome
//  automatically on macOS 26+.
//

import SwiftUI

struct ContentView: View {
    @Environment(SessionStore.self) private var store
    @State private var selection: Session.ID?
    @State private var showNewSessionSheet = false

    var body: some View {
        NavigationSplitView {
            SidebarView(selection: $selection, showNewSessionSheet: $showNewSessionSheet)
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } detail: {
            DetailView(session: selectedSession)
        }
        .frame(minWidth: 760, minHeight: 480)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    showNewSessionSheet = true
                } label: {
                    Label("New Session", systemImage: "plus")
                }
                .keyboardShortcut("n", modifiers: [.command])
                .help("Create a new session (⌘N)")
            }
        }
        .sheet(isPresented: $showNewSessionSheet) {
            NewSessionSheet()
        }
    }

    private var selectedSession: Session? {
        guard let selection else { return nil }
        return store.sessions.first(where: { $0.id == selection })
    }
}

#Preview {
    ContentView()
        .environment(SessionStore())
}
