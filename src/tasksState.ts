import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

export const TASKS_ROOT = path.join(homedir(), ".baywatch", "tasks")

// The durable {repo → branch} bundle a Task carries. A session cuts/continues
// these branches; the mainClonePath is the user's real checkout to fetch back
// into. See DESIGN.md.
export type TaskRepo = {
    ownerRepo: string
    branch: string
    mainClonePath: string
}

// A Task is the feature you come back to: a set of repos+branches that outlives
// any single session. Sessions are ephemeral runs against a Task (see
// sessionsState.ts, SessionMeta.taskId).
export type Task = {
    id: string
    name: string
    query?: string
    repos: TaskRepo[]
    createdAt: number
}

function taskFile(id: string): string {
    return path.join(TASKS_ROOT, id, "task.json")
}

export function readTask(id: string): Task | null {
    const p = taskFile(id)
    if (!existsSync(p)) return null
    try {
        return JSON.parse(readFileSync(p, "utf8")) as Task
    } catch {
        return null
    }
}

export function writeTask(task: Task): void {
    mkdirSync(path.join(TASKS_ROOT, task.id), { recursive: true })
    writeFileSync(taskFile(task.id), JSON.stringify(task, null, 2))
}

export function listTasks(): Task[] {
    if (!existsSync(TASKS_ROOT)) return []
    const ids = readdirSync(TASKS_ROOT).filter((entry) => {
        try {
            return statSync(path.join(TASKS_ROOT, entry)).isDirectory()
        } catch {
            return false
        }
    })
    const tasks: Task[] = []
    for (const id of ids) {
        const t = readTask(id)
        if (t) tasks.push(t)
    }
    return tasks
}

export function findTask(idOrName: string): Task | null {
    const byId = readTask(idOrName)
    if (byId) return byId
    return listTasks().find((t) => t.name === idOrName) ?? null
}
