//
//  NotificationService.swift
//  baywatch
//
//  Fires macOS banner notifications when a session transitions into a state
//  that wants the user's attention (`awaiting-input`, `failed`) or finishes
//  (`done`). One-shot permission request at app launch; no persistent
//  background state required.
//

import Foundation
@preconcurrency import UserNotifications

@MainActor
final class NotificationService {
    static let shared = NotificationService()

    private let center = UNUserNotificationCenter.current()

    func requestAuthorization() {
        center.requestAuthorization(options: [.alert, .sound]) { _, error in
            if let error {
                NSLog("Notification authorization error: \(error.localizedDescription)")
            }
        }
    }

    /// Fires a notification for a single state transition.
    func notify(session: SessionMeta, newState: SessionState, oldState: SessionState?) {
        guard shouldNotify(transitioningTo: newState, from: oldState) else { return }

        let content = UNMutableNotificationContent()
        content.title = title(for: newState, sessionName: session.name)
        content.subtitle = session.repos.map { $0.ownerRepo }.joined(separator: ", ")
        content.body = body(for: newState)
        content.sound = .default
        content.userInfo = ["sessionId": session.id]

        let request = UNNotificationRequest(
            identifier: "baywatch.session.\(session.id).\(newState.rawValue).\(Date().timeIntervalSince1970)",
            content: content,
            trigger: nil // deliver immediately
        )
        center.add(request)
    }

    private func shouldNotify(transitioningTo new: SessionState, from old: SessionState?) -> Bool {
        // Suppress notifications when there's no prior state — that means the
        // app just launched and "discovered" the state, the transition wasn't
        // generated while the app was running.
        guard let old, old != new else { return false }
        switch new {
        case .awaitingInput, .failed, .done: return true
        default: return false
        }
    }

    private func title(for state: SessionState, sessionName: String) -> String {
        switch state {
        case .awaitingInput: "\(sessionName) needs input"
        case .failed: "\(sessionName) failed"
        case .done: "\(sessionName) finished"
        default: sessionName
        }
    }

    private func body(for state: SessionState) -> String {
        switch state {
        case .awaitingInput: "Click to review the question."
        case .failed: "The session ended with an error."
        case .done: "Ready for review."
        default: ""
        }
    }
}
