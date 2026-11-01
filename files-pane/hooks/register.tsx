import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import {
  absOf,
  afterCommit,
  commitDir,
  describe,
  endWork,
  follow,
  keepTurn,
  refreshDiff,
  reveal,
  setNow,
  settle,
  startWork,
  touchOf,
  upsert,
} from './activity'
import { forget, headOf, redraw, refreshGit, sessionDir } from './disk'
import { hostOf } from './editors'
import { renderPane } from './pane'
import { base, rel, tailOf } from './paths'
import { PANE } from './state'

// The values this file reads or writes. The engine's scan wants each made by `atom` in the file that
// uses it, so every file names its own; state.ts lists the tags they must all share.
const diff = atom({ plugin: 'files-pane', key: 'diff' } as const, null, { shape: 'diff-2' })
const menu = atom({ plugin: 'files-pane', key: 'menu' } as const, null, { shape: 'menu-2' })
const status = atom({ plugin: 'files-pane', key: 'status' } as const, null, { shape: 'status-1' })
const touched = atom({ plugin: 'files-pane', key: 'touched' } as const, [], { shape: 'touched-3' })

// The mod's hooks: what Claude does reaches the pane through these. The pane is drawn in pane.tsx;
// what it reads of the disk is in disk.ts, and what it makes of Claude's work in activity.ts.

const openPane = async ($: EngineInterface) => {
  const cwd = await sessionDir($).catch(() => '')

  return $.ui.open({ id: PANE, title: `Files: ${base(cwd) || 'project'}` })
}

// Set up once per session: /files, the pane and git. session.start alone is not enough: a mod
// installed while a session runs is loaded into it after the start, and an organization's guard
// may skip a user mod's session.start. The first turn then does it instead.
let isReady = false

const setUp = async ($: EngineInterface) => {
  if (isReady) return

  isReady = true
  await $.command.register({ name: 'files', description: 'Show the Files pane: what Claude reads and edits, and the project tree' })
  void openPane($).catch(() => {})
  void refreshGit($)
  // Ahead of the first ⋯, so its menu opens with the editors already found.
  void hostOf($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    forget()
    await setUp($).catch(() => {})

    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await openPane($)

    return { text: 'Files pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    // The pane's bookkeeping never stands between Claude and its tool: a failure here is dropped.
    const cwd = await sessionDir($).catch(() => '')
    const repo = commitDir(e, cwd)

    if (repo !== null) {
      // HEAD before, so a commit that does not happen is not taken for one.
      const before = await headOf($, repo).catch(() => null)
      await update($, status, () => ({ verb: 'committing' }) as const).catch(() => {})
      redraw($)

      try {
        return await next(e)
      } finally {
        await afterCommit($, cwd, repo, before).catch(() => {})
      }
    }

    const hit = touchOf(e)

    if (!hit) {
      const id = await startWork($, { verb: 'working', tool: e.tool, ...describe(e, cwd) }).catch(() => 0)

      try {
        return await next(e)
      } finally {
        await endWork($, id).catch(() => {})
        // A command may have made, moved or removed files: the tree lists its folders again, and
        // git, which only a command can change, is read again.
        forget()
        if (e.tool === 'Bash') void refreshGit($)
        redraw($)
      }
    }

    const abs = absOf(cwd, hit.path)
    const path = rel(cwd, abs)
    await setNow($, () => ({ verb: hit.isEdit ? 'editing' : 'reading', path }))
    await update($, touched, list => upsert(list, path, hit.isEdit)).catch(() => {})
    const shown = await follow($, cwd, abs, hit.isEdit).catch(() => null)
    redraw($)
    if (shown) void reveal($, shown)

    try {
      return await next(e)
    } finally {
      const list = await update($, touched, old => old.map(one => (one.path === path ? { ...one, isActive: false } : one))).catch(() => null)

      if (list) await settle($, list).catch(() => {})
      redraw($)

      if (hit.isEdit) {
        forget()
        void refreshGit($)
        void refreshDiff($, abs).catch(() => {})
      }
    }
  })

  // What Claude thinks and writes, as it streams: the card shows its latest words, as often as
  // `setNow` lets it, and the last of them once the stream ends.
  on('turn.step', async function* ($, e, next) {
    const stream = next(e)

    if (e.agentId) return yield* stream

    let thought = ''
    let answer = ''

    for (;;) {
      const step = await stream.next()

      if (step.done) return step.value

      const chunk = step.value

      if (chunk.kind === 'thinking') {
        thought += chunk.text
        void setNow($, () => ({ verb: 'thinking', thought: tailOf(thought) }))
      } else if (chunk.kind === 'text') {
        answer += chunk.text
        void setNow($, () => ({ verb: 'writing', text: tailOf(answer) }))
      }

      yield chunk
    }
  })

  on('turn.start', async ($, e, next) => {
    await setUp($).catch(() => {})

    if (!e.agentId) {
      // The last turn's files go to the whole-session list before this turn starts its own.
      await keepTurn($).catch(() => {})
      await update($, touched, () => [])
      // A prompt sent is a click away from a file's actions: they close, with their diff, rather
      // than come back on the file's row when Claude touches it again.
      await update($, menu, () => null)
      await update($, diff, () => null)
      await setNow($, () => ({ verb: 'thinking' }))
      await update($, status, () => null)
      redraw($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const list = (await read($, touched)).map(one => ({ ...one, isActive: false }))
    await update($, touched, () => list)

    // A commit this turn stays the card's news; otherwise the turn's summary.
    await setNow($, old =>
      old?.verb === 'committed'
        ? old
        : { verb: 'done', edited: list.filter(one => one.isEdited).map(one => one.path), read: list.filter(one => !one.isEdited).map(one => one.path) },
    )

    forget()
    void refreshGit($)

    return result
  })

  // A press anywhere else in the pane closes a file's actions, as a click away closes a native
  // menu, and still does its own work. The menu's rows, and the ⋯ that opened it, end in its
  // address, so they pass untouched.
  on('ui.press', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    const open = await read($, menu).catch(() => null)
    if (open && !e.element.endsWith(`:${open.where}:${open.path}`)) {
      await update($, menu, () => null)
      await update($, diff, () => null)
      redraw($)
    }

    return next(e)
  })

  // Typing in the prompt is a click away from the pane too: it closes a file's actions.
  on('prompt.edit', async ($, e, next) => {
    if (await read($, menu).catch(() => null)) {
      await update($, menu, () => null)
      await update($, diff, () => null)
      redraw($)
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => renderPane($, e))
}
