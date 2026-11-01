// A unified diff as the rows the pane draws: a header row per hunk, then each line with its number
// in the file, as an editor's diff shows it.

export type DiffRow =
  | { kind: 'hunk'; line: number; context: string }
  | { kind: 'add' | 'del' | 'same'; line: number; text: string }

// A tab as two spaces: the pane is narrow, and a row is cut at its end, never wrapped.
const TAB = '  '

// The rows of `text`, git's hunks: a removed line numbered where it was, the others where they
// are now. The indent every line shares is taken off, so the change starts at the row's left.
export function rowsOf(text: string): DiffRow[] {
  const rows: DiffRow[] = []
  let old = 0
  let now = 0
  // Lines count only inside a hunk: before the first, git's file header (its `---` and `+++` are
  // no removed and added line); a file's next `diff --git` ends one.
  let isInHunk = false
  const all = text.split('\n')

  // The newline git ends its output with is no blank line of the file.
  if (all[all.length - 1] === '') all.pop()

  for (const raw of all) {
    const header = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/)

    if (header) {
      isInHunk = true
      old = Number(header[1])
      now = Number(header[2])
      // A new file's hunk starts at line 0 of nothing: its first line is 1.
      if (now === 0) now = 1
      rows.push({ kind: 'hunk', line: now, context: header[3]!.trim() })
      continue
    }

    if (raw.startsWith('diff ')) isInHunk = false
    if (!isInHunk) continue

    // `\ No newline at end of file` is no line of the file. A kept line printed as nothing (a
    // blank one some tools strip of its space) is one.
    const mark = raw === '' ? ' ' : raw[0]

    if (mark !== '+' && mark !== '-' && mark !== ' ') continue

    const line = raw.slice(1).replace(/\t/g, TAB)

    if (mark === '+') rows.push({ kind: 'add', line: now++, text: line })
    else if (mark === '-') rows.push({ kind: 'del', line: old++, text: line })
    else rows.push({ kind: 'same', line: (old++, now++), text: line })
  }

  const lines = rows.filter(row => row.kind !== 'hunk' && row.text.trim() !== '') as { text: string }[]
  const shared = lines.length === 0 ? 0 : Math.min(...lines.map(row => row.text.length - row.text.trimStart().length))

  return shared === 0 ? rows : rows.map(row => (row.kind === 'hunk' ? row : { ...row, text: row.text.slice(shared) }))
}
