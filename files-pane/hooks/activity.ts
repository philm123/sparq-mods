import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Now, Touch } from '../types'
import { diffOf, forget, gitPath, headOf, redraw, refreshGit, run } from './disk'
import { clip, closedAbove, dirOf, firstLine, fromShell, isAbs, isUnder, join, rel, slashed } from './paths'
import { DEFAULT_VIEW, PANE } from './state'

// The values this file reads or writes. The engine's scan wants each made by `atom` in the file that
// uses it, so every file names its own; state.ts lists the tags they must all share.
const diff = atom({ plugin: 'files-pane', key: 'diff' } as const, null, { shape: 'diff-2' })
const earlier = atom({ plugin: 'files-pane', key: 'earlier' } as const, [], { shape: 'touched-3' })
const now = atom({ plugin: 'files-pane', key: 'now' } as const, null, { shape: 'now-3' })
const status = atom({ plugin: 'files-pane', key: 'status' } as const, null, { shape: 'status-1' })
const touched = atom({ plugin: 'files-pane', key: 'touched' } as const, [], { shape: 'touched-3' })
const view = atom({ plugin: 'files-pane', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-3' })

// What Claude is doing and what it touched: the card's state, the touched list, the tree following
// Claude between projects, and what a commit changes.

const READS = new Set(['Read'])
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const COMMIT = /\bgit\s+(?:-C\s+(\S+)\s+)?commit\b/
const CD = /(?:^|[;&|]\s*)cd\s+(\S+)/g

// The file a tool call reads or edits, if it is one of those, slashed.
export const touchOf = (e: { tool: string }) => {
  const input = e as unknown as Record<string, unknown>
  const named = typeof input.file_path === 'string' ? input.file_path : input.notebook_path

  if (typeof named !== 'string') return null

  const path = slashed(named)

  if (EDITS.has(e.tool)) return { path, isEdit: true }
  if (READS.has(e.tool)) return { path, isEdit: false }

  return null
}

// What a tool call other than a read or an edit is doing, in words: a title and the detail under it.
export const describe = (e: { tool: string }, cwd: string): { title: string; detail: string } => {
  const input = e as unknown as Record<string, unknown>
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const where = (path: string) => (path ? rel(cwd, slashed(path)) : '')

  switch (e.tool) {
    case 'Bash':
      return { title: text('description') ? clip(text('description'), 60) : 'Running a command', detail: clip(firstLine(text('command')), 80) }
    case 'Grep':
      return { title: `Searching for “${clip(text('pattern'), 40)}”`, detail: where(text('path')) || text('glob') || 'in the project' }
    case 'Glob':
      return { title: 'Finding files', detail: text('pattern') }
    case 'WebFetch':
      return { title: `Reading ${text('url').replace(/^https?:\/\/(www\.)?/, '').split('/')[0] || 'a web page'}`, detail: clip(text('url'), 80) }
    case 'WebSearch':
      return { title: 'Searching the web', detail: clip(text('query'), 80) }
    case 'Task':
    case 'Agent':
      return { title: 'Handing work to a subagent', detail: clip(text('description') || firstLine(text('prompt')), 80) }
    case 'TodoWrite':
      return { title: 'Updating the plan', detail: '' }
    default: {
      // An MCP tool is `mcp__<server>__<tool>`: say both, readably.
      const [, server, name] = e.tool.match(/^mcp__(.+?)__(.+)$/) ?? []

      return server ? { title: `Using ${name!.replace(/[_-]+/g, ' ')}`, detail: server.replace(/[_-]+/g, ' ') } : { title: `Using ${e.tool}`, detail: '' }
    }
  }
}

// The folder a `git commit` runs in, absolute: its `-C` folder, else the last `cd` before it, else
// the session's. Null when the call is no commit. A folder from `~` cannot be told: the session's.
// On Windows the command runs in Git Bash, which may name a folder `/c/proj`.
export const commitDir = (e: { tool: string }, cwd: string) => {
  const command = (e as unknown as Record<string, unknown>).command

  if (e.tool !== 'Bash' || typeof command !== 'string') return null

  const match = command.match(COMMIT)

  if (!match) return null

  const named = match[1] ?? [...command.slice(0, match.index).matchAll(CD)].pop()?.[1]
  const unquoted = named?.replace(/^(['"])(.*)\1$/, '$2')

  if (!unquoted || unquoted.startsWith('~')) return cwd

  const dir = fromShell(cwd, slashed(unquoted))

  return isAbs(dir) ? dir : join(cwd, dir)
}

export const upsert = (list: Touch[], path: string, isEdit: boolean): Touch[] => {
  const old = list.find(one => one.path === path)
  const touch: Touch = { path, isEdited: isEdit || Boolean(old?.isEdited), isActive: true, isCommitted: false, at: old?.at ?? Date.now() }

  // A file keeps its place in the list: files stay in the order Claude first touched them.
  return old ? list.map(one => (one.path === path ? touch : one)) : [...list, touch].slice(-100)
}

// A finished turn's files join the earlier turns', for the whole-session list: a file touched again
// moves to the end, with what this turn did to it.
export async function keepTurn($: EngineInterface) {
  const done = (await read($, touched)).map(one => ({ ...one, isActive: false }))

  if (done.length === 0) return

  await update($, earlier, old => [...old.filter(one => !done.some(again => again.path === one.path)), ...done].slice(-300))
}

// The card between tools: what this turn has done so far.
export const between = (list: Touch[]): Now =>
  list.some(one => one.isEdited)
    ? { verb: 'done', edited: list.filter(one => one.isEdited).map(one => one.path), read: list.filter(one => !one.isEdited).map(one => one.path) }
    : { verb: 'thinking' }

// The card changes through `setNow` alone, which holds each state at least DWELL_MS: a quick tool
// call would otherwise flash past, and a stream redraw the card many times a second. `wanted` is
// the newest state asked for; while a state is held, the newest one waits and then shows.
const DWELL_MS = 700
let wanted: Now | null | undefined
let shownAt = 0
let isHeld = false

// When the card took the state it shows, for a badge that draws itself once.
export const cardSince = () => shownAt

async function showNow($: EngineInterface) {
  const value = wanted ?? null

  shownAt = Date.now()
  await update($, now, () => value).catch(() => {})
  redraw($)
}

// `fn` maps the newest state asked for (not the one on screen) to the next.
export async function setNow($: EngineInterface, fn: (old: Now | null) => Now | null) {
  if (wanted === undefined) wanted = await read($, now).catch(() => null)

  wanted = fn(wanted)

  if (isHeld) return

  const wait = shownAt + DWELL_MS - Date.now()

  if (wait <= 0) return showNow($)

  // Without a clock the state shows at once.
  isHeld = true
  void $.clock
    .sleep(wait)
    .catch(() => {})
    .then(() => {
      isHeld = false

      return showNow($)
    })
}

// Tool calls other than reads and edits that are still running, by the order they began: Claude
// may run several at once, and the card shows the newest of them until the last one ends.
const running = new Map<number, Now>()
let calls = 0

export async function startWork($: EngineInterface, doing: Now) {
  const id = ++calls

  running.set(id, doing)
  await setNow($, () => doing)

  return id
}

// What the card shows once a tool call ends: a file Claude still has in hand, else a call still
// running, else what the turn has done. Streamed thinking or writing that took the card stays.
export async function settle($: EngineInterface, list: Touch[]) {
  const held = list.filter(one => one.isActive).pop()
  const next: Now = held ? { verb: held.isEdited ? 'editing' : 'reading', path: held.path } : ([...running.values()].pop() ?? between(list))

  await setNow($, old => (old === null || old.verb === 'working' || old.verb === 'reading' || old.verb === 'editing' ? next : old))
}

export async function endWork($: EngineInterface, id: number) {
  running.delete(id)
  await settle($, await read($, touched).catch(() => []))
}

// The tree follows Claude between projects: a file in another project moves it to that project (its
// git root, else the file's folder), a file back home moves it home. A file Claude edits opens the
// folders down to it, so the change is in sight; a file it only reads opens none, and its closed
// folder shows Claude at work inside with a dot. An edit outside the folder the tree shows takes it
// back to the project's top. Resolves the edited file's tree path, for the pane to scroll to.
export async function follow($: EngineInterface, cwd: string, abs: string, isEdit: boolean): Promise<string | null> {
  const old = await read($, view)
  const shown = old.root || cwd
  let root = old.root

  if (!abs.startsWith(`${shown}/`)) {
    if (abs.startsWith(`${cwd}/`)) root = ''
    else {
      root = gitPath(await run($, ['git', 'rev-parse', '--show-toplevel'], 3000, dirOf(abs))) ?? dirOf(abs)
      if (root === cwd) root = ''
    }
  }

  const isMoved = root !== old.root
  const path = abs.slice((root || cwd).length + 1)
  const isOut = isEdit && !isMoved && !isUnder(old.dir, path)
  const start = isMoved ? { ...old, root, dir: '', expanded: [] } : isOut ? { ...old, dir: '' } : old
  const opened = isEdit ? closedAbove(start, path) : []

  if (isMoved || isOut || opened.length > 0) {
    // Merged into the newest view, so a folder the person opened meanwhile stays open.
    await update($, view, now => (isMoved || isOut ? { ...start, expanded: [...start.expanded, ...opened] } : { ...now, expanded: [...now.expanded, ...opened.filter(dir => !now.expanded.includes(dir))] }))
  }

  if (isMoved) {
    forget()
    void refreshGit($)
  }

  return isEdit ? path : null
}

// Brings a row of the tree into sight in the pane, once it is drawn. A pane not placed, or a
// surface that does not scroll, refuses; nothing depends on it.
export function reveal($: EngineInterface, path: string) {
  return $.ui.scroll({ in: PANE, to: { key: `row:${path}` }, block: 'nearest' }).catch(() => ({}))
}

// A file as an absolute path: the touched list spells one relative to the session's folder.
export const absOf = (cwd: string, path: string) => (isAbs(path) ? path : join(cwd, path))

// Opens the diff of a file (absolute), or closes it when it is the one open.
export async function toggleDiff($: EngineInterface, path: string) {
  if ((await read($, diff))?.path === path) {
    await update($, diff, () => null)
  } else {
    const found = await diffOf($, path)
    await update($, diff, () => ({ path, ...found }))
  }

  redraw($)
}

// The open diff read again, after Claude edits its file (absolute) or commits; a diff with nothing
// left closes.
export async function refreshDiff($: EngineInterface, path?: string) {
  const open = await read($, diff)

  if (!open || (path !== undefined && open.path !== path)) return

  const found = await diffOf($, open.path)
  await update($, diff, () => (found.text ? { path: open.path, ...found } : null))
  redraw($)
}

// After Claude's `git commit` in `repo`: the hash at the foot, the committed files marked green, the
// card's news. A commit refused (by a hook, or with nothing to commit) leaves HEAD at `before`, and
// then nothing turns green.
export async function afterCommit($: EngineInterface, cwd: string, repo: string, before: string | null): Promise<void> {
  const hash = await headOf($, repo)

  if (!hash || hash === before) {
    await update($, status, () => null)
    redraw($)

    return
  }

  // The commit's files name paths from the repository's top, which may sit above `repo`.
  const [top, shown] = await Promise.all([
    run($, ['git', 'rev-parse', '--show-toplevel'], 5000, repo),
    run($, ['git', 'show', '--name-only', '-z', '--format=', 'HEAD'], 5000, repo),
  ])
  const root = gitPath(top) ?? repo
  const files = (shown?.stdout ?? '').split(/\0|\n/).filter(Boolean)
  const inCommit = new Set(files.map(file => join(root, file)))
  const mark = (list: Touch[]) => list.map(one => (inCommit.has(absOf(cwd, one.path)) ? { ...one, isActive: false, isCommitted: true } : one))

  await update($, status, () => ({ verb: 'committed', hash }) as const)
  await update($, touched, mark)
  await update($, earlier, mark)
  await setNow($, () => ({ verb: 'committed', hash, files }))
  forget()
  await refreshGit($)
  await refreshDiff($)
}
