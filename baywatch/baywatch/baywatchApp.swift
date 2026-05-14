//
//  baywatchApp.swift
//  baywatch
//

import SwiftUI

@main
struct baywatchApp: App {
    @State private var sessionStore = SessionStore()
    @State private var diffStore = DiffStore()
    @State private var commentStore = CommentStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(sessionStore)
                .environment(diffStore)
                .environment(commentStore)
                .task {
                    NotificationService.shared.requestAuthorization()
                    sessionStore.startPolling()
                }
                .onDisappear { sessionStore.stopPolling() }
        }
        .windowToolbarStyle(.unified)

        Settings {
            SettingsView()
        }
    }
}
