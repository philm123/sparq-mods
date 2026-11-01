import type { View } from '../types'

export const PANE = 'files-pane'

// Hidden files show by default, as in VS Code's explorer: the toolbar offers to hide them.
export const DEFAULT_VIEW: View = { query: '', root: '', dir: '', expanded: [], showSizes: false, showHidden: true }

// The pane's values, each made by `atom` in every file that uses it (the engine's scan reads only
// an atom made in the file at hand), so their tags live here to be kept the same. Change a tag when
// its value's fields change: it declines what an earlier version stored.
//
//   now      'now-3'      what the card says: Now | null
//   touched  'touched-3'  this turn's files: Touch[]
//   earlier  'touched-3'  the earlier turns' files, for the whole-session list: Touch[]
//   scope    'scope-1'    which of those the list shows: Scope
//   isTouchedAll (none)   whether that list shows every file, past the newest few: boolean
//   view     'view-3'     the tree's controls: View
//   git      'git-4'      git's view of the project shown: Git | null
//   diff     'diff-2'     the diff open under a file's row: Diff | null
//   menu     'menu-2'     the file whose actions are open, and their submenu: Menu | null
//   status   'status-1'   the commit line at the pane's foot: Status | null
//   tick     (none)       bumped by Refresh, so the tree is listed again
