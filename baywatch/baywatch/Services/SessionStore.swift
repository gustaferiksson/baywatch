//
//  SessionStore.swift
//  baywatch
//
//  Discovers sessions + tasks on disk and polls hook events + podman state to
//  derive the runtime state for each. Sessions are grouped under their Task for
//  the two-level sidebar. Pure read side — never writes; the CLI owns mutations.
//
//  Disk + subprocess work runs on a detached task; only the final state
//  assignment hops back to the main actor. This keeps the polling loop from
//  blocking the SwiftTerm input handler every tick.
//

import Foundation
import Observation

// A Task and the sessions that are runs of it — the sidebar's top level.
struct SessionGroup: Identifiable {
    let id: String        // taskId
    let taskName: String
    let repoSummary: String
    let sessions: [Session]
}

@Observable
@MainActor
final class SessionStore {
    private(set) var sessions: [Session] = []
    private(set) var tasks: [TaskMeta] = []
    private(set) var groups: [SessionGroup] = []
    private(set) var lastError: String?

    private var timer: Timer?
    private var previousStates: [String: SessionState] = [:]
    private var refreshTask: Task<Void, Never>?

    func startPolling(interval: TimeInterval = 3.0) {
        timer?.invalidate()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
        refreshTask?.cancel()
        refreshTask = nil
    }

    func refresh() {
        // Coalesce: if a refresh is already in flight, skip this tick.
        if let existing = refreshTask, !existing.isCancelled { return }

        refreshTask = Task.detached(priority: .userInitiated) { [weak self] in
            let result = SessionStoreScanner.scan()
            await self?.apply(scanResult: result)
        }
    }

    private func apply(scanResult result: SessionStoreScanner.ScanResult) {
        // Sort attention-grabbing first.
        sessions = result.sessions.sorted { lhs, rhs in
            if lhs.state.sortRank != rhs.state.sortRank {
                return lhs.state.sortRank < rhs.state.sortRank
            }
            return lhs.lastEventAt > rhs.lastEventAt
        }
        tasks = result.tasks
        lastError = result.error
        rebuildGroups()

        // Fire notifications for transitions detected this tick.
        for session in sessions {
            let old = previousStates[session.id]
            if old != session.state {
                NotificationService.shared.notify(
                    session: session.meta,
                    newState: session.state,
                    oldState: old
                )
                previousStates[session.id] = session.state
            }
        }
        let aliveIds = Set(sessions.map { $0.id })
        previousStates = previousStates.filter { aliveIds.contains($0.key) }

        refreshTask = nil
    }

    // Group the (already attention-sorted) sessions under their Task. First-seen
    // order over the sorted sessions floats attention-grabbing tasks up. A task
    // whose task.json is missing falls back to its first session's details.
    private func rebuildGroups() {
        let tasksById = Dictionary(tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var order: [String] = []
        var byTask: [String: [Session]] = [:]
        for session in sessions {
            let key = session.meta.taskId
            if byTask[key] == nil { order.append(key) }
            byTask[key, default: []].append(session)
        }
        groups = order.map { key in
            let sess = byTask[key] ?? []
            let task = tasksById[key]
            let name = task?.name ?? sess.first?.meta.name ?? key
            let repos = task?.repos.map { $0.ownerRepo } ?? sess.first?.meta.repos.map { $0.ownerRepo } ?? []
            return SessionGroup(id: key, taskName: name, repoSummary: repos.joined(separator: ", "), sessions: sess)
        }
    }
}

/// Pure scan logic, callable off the main actor. No SwiftUI / Observable state
/// — returns a value the caller hops back to main to apply.
enum SessionStoreScanner {
    struct ScanResult {
        let sessions: [Session]
        let tasks: [TaskMeta]
        let error: String?
    }

    static func scan() -> ScanResult {
        let fm = FileManager.default
        let root = fm.homeDirectoryForCurrentUser
            .appendingPathComponent(".baywatch/sessions")

        guard fm.fileExists(atPath: root.path) else {
            return ScanResult(sessions: [], tasks: scanTasks(), error: nil)
        }

        let directories: [URL]
        do {
            directories = try fm.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )
        } catch {
            return ScanResult(sessions: [], tasks: scanTasks(), error: "Failed to list \(root.path): \(error.localizedDescription)")
        }

        let liveContainerIds = currentLiveContainerIds()
        var out: [Session] = []
        for dir in directories {
            guard (try? dir.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else {
                continue
            }
            guard let meta = readMeta(in: dir) else { continue }
            let events = readEvents(in: dir)
            let alive = liveContainerIds.contains(where: { meta.containerId.hasPrefix($0) })
            let state = deriveState(events: events, alive: alive)
            let lastTs = events.last?.ts ?? meta.startedAt
            out.append(Session(meta: meta, state: state, lastEventAt: lastTs))
        }
        return ScanResult(sessions: out, tasks: scanTasks(), error: nil)
    }

    // MARK: - file parsing

    private static func readMeta(in dir: URL) -> SessionMeta? {
        let metaPath = dir.appendingPathComponent("meta.json")
        guard let data = try? Data(contentsOf: metaPath) else { return nil }
        return try? JSONDecoder().decode(SessionMeta.self, from: data)
    }

    private static func scanTasks() -> [TaskMeta] {
        let fm = FileManager.default
        let root = fm.homeDirectoryForCurrentUser.appendingPathComponent(".baywatch/tasks")
        guard fm.fileExists(atPath: root.path),
              let dirs = try? fm.contentsOfDirectory(
                  at: root,
                  includingPropertiesForKeys: [.isDirectoryKey],
                  options: [.skipsHiddenFiles]
              )
        else { return [] }
        var out: [TaskMeta] = []
        for dir in dirs {
            let p = dir.appendingPathComponent("task.json")
            guard let data = try? Data(contentsOf: p),
                  let task = try? JSONDecoder().decode(TaskMeta.self, from: data)
            else { continue }
            out.append(task)
        }
        return out
    }

    private static func readEvents(in dir: URL) -> [HookEvent] {
        let statusPath = dir.appendingPathComponent("status.jsonl")
        guard let text = try? String(contentsOf: statusPath, encoding: .utf8) else { return [] }
        let decoder = JSONDecoder()
        return text.split(separator: "\n").compactMap { line in
            guard let data = line.data(using: .utf8) else { return nil }
            return try? decoder.decode(HookEvent.self, from: data)
        }
    }

    private static func deriveState(events: [HookEvent], alive: Bool) -> SessionState {
        guard alive else {
            if let last = events.last, last.event == "SessionEnd" { return .done }
            return .stopped
        }
        guard let last = events.last else { return .starting }
        switch last.event {
        case "Notification": return .awaitingInput
        case "Stop": return .idle
        default: return .working
        }
    }

    // MARK: - podman bridge

    private static func currentLiveContainerIds() -> Set<String> {
        let result = CommandRunner.run("podman", ["ps", "-q", "--filter", "name=baywatch-session-"])
        guard result.ok else { return [] }
        return Set(
            result.stdout
                .split(separator: "\n")
                .map { String($0).trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
        )
    }
}
