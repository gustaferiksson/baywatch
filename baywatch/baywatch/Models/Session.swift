//
//  Session.swift
//  baywatch
//
//  Mirrors the SessionMeta/SessionRow shape baywatch's CLI writes to disk
//  under ~/.baywatch/sessions/<id>/. Source of truth lives in TS; this is
//  the read-only view the macOS app uses.
//

import Foundation

enum SessionState: String, Codable, Hashable {
    case starting
    case working
    case awaitingInput = "awaiting-input"
    case idle
    case done
    case failed
    case stopped

    /// Order used to sort the sidebar — attention-grabbing first.
    var sortRank: Int {
        switch self {
        case .awaitingInput: 0
        case .working: 1
        case .starting: 2
        case .idle: 3
        case .failed: 4
        case .done: 5
        case .stopped: 6
        }
    }

    var displayName: String {
        switch self {
        case .awaitingInput: "Needs input"
        case .working: "Working"
        case .starting: "Starting"
        case .idle: "Idle"
        case .done: "Done"
        case .failed: "Failed"
        case .stopped: "Stopped"
        }
    }
}

/// Persisted metadata for a baywatch session. Written by the CLI's
/// `runSession` to ~/.baywatch/sessions/<id>/meta.json.
/// One repo within a session's sandbox — mirrors the CLI's SessionRepo.
struct SessionRepo: Codable, Hashable {
    let ownerRepo: String
    let branch: String
    let clonePath: String
}

struct SessionMeta: Codable, Hashable, Identifiable {
    let id: String
    let taskId: String
    let name: String
    let repos: [SessionRepo]
    let containerName: String
    let containerId: String
    let startedAt: Int
    let rcEnvironmentUrl: String?

    /// Single-repo convenience for the current UI during the multi-repo
    /// transition. The two-level sidebar / per-repo detail slice supersedes it.
    var primaryRepo: SessionRepo? { repos.first }
}

/// One hook event line from status.jsonl.
struct HookEvent: Codable {
    let ts: Int
    let event: String
}

/// SessionMeta + derived runtime state. What the sidebar renders.
struct Session: Identifiable, Hashable {
    let meta: SessionMeta
    let state: SessionState
    let lastEventAt: Int

    var id: String { meta.id }
}
