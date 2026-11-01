// What Claude is doing right now: a file in hand, another tool at work, thinking (with the tail of
// its thought as it streams), writing its answer, a turn's summary or a commit.
export type Now =
  | { verb: 'reading' | 'editing'; path: string }
  | { verb: 'working'; tool: string; title: string; detail: string }
  | { verb: 'thinking'; thought?: string }
  | { verb: 'writing'; text: string }
  | { verb: 'done'; edited: string[]; read: string[] }
  | { verb: 'committed'; hash: string; files: string[] }

// A file Claude touched this turn, its path relative to the working directory, and when Claude
// first touched it (milliseconds since the epoch).
export type Touch = { path: string; isEdited: boolean; isActive: boolean; isCommitted: boolean; at: number }

// The pane's own controls: search text, the project shown (`root`, absolute; empty for the
// session's folder), the folder shown under it, open folders and toggles.
export type View = {
  query: string
  root: string
  dir: string
  expanded: string[]
  showSizes: boolean
  showHidden: boolean
}

// The branch, how far it is ahead of its upstream (null without one), the paths git reports as
// changed with the letter each one gets and their added and removed line counts, and what it
// ignores (a folder as `dir/`), all relative to the working directory.
export type Git = {
  branch: string
  ahead: number | null
  changed: string[]
  marks: Record<string, Mark>
  lines: Record<string, [number, number]>
  ignored: string[]
}

// What git sees in a changed file, as VS Code's explorer letters it: modified, added, deleted,
// renamed, untracked, or in conflict.
export type Mark = 'M' | 'A' | 'D' | 'R' | 'U' | 'C'

// The line at the foot of the pane while Claude commits, and the commit it made.
export type Status = { verb: 'committing' } | { verb: 'committed'; hash: string }

// The diff open under a file's row: the file, absolute, its unified-diff hunks since HEAD, and how
// many lines were left out past the pane's limit.
export type Diff = { path: string; text: string; more: number }

// The file whose actions are open under its row (its ⋯ pressed), absolute, which list the row is
// in (the tree, search's matches or the files Claude touched), and the submenu open in them, if any.
export type Menu = { path: string; where: 'tree' | 'match' | 'touched'; sub: 'copy' | 'open' | null }

// What the touched list shows: this turn's files, or every file Claude touched this session.
export type Scope = 'turn' | 'session'

declare module 'claude-code' {
  interface PluginState {
    'files-pane': {
      now: Shaped<Now | null>
      touched: Shaped<Touch[]>
      earlier: Shaped<Touch[]>
      scope: Shaped<Scope>
      // Whether the touched list shows every file, past the newest few it shows by itself.
      isTouchedAll: boolean
      view: Shaped<View>
      git: Shaped<Git | null>
      diff: Shaped<Diff | null>
      menu: Shaped<Menu | null>
      status: Shaped<Status | null>
      tick: number
    }
  }
}
