import type { View } from '../types'

// A path as the pane spells it on every system: folders split by `/`. Windows hands the pane
// `C:\proj\src` where git prints `C:/proj/src`, so a Windows path (from a drive, or a `\\` share)
// takes `/` and a capital drive letter as it comes in, and stays one spelling inside. Any other
// path is left alone: on macOS and Linux a `\` is part of a name.
export const slashed = (path: string) =>
  /^(?:[A-Za-z]:[\\/]|\\\\)/.test(path) ? path.replace(/\\/g, '/').replace(/^[a-z]:/, drive => drive.toUpperCase()) : path

// Whether a path, as slashed, is a Windows one: from a drive, or a share.
export const isWindowsPath = (path: string) => /^(?:[A-Z]:\/|\/\/)/.test(path)

// The way Windows spells a slashed path, for what a person copies or Explorer opens.
export const backslashed = (path: string) => path.replace(/\//g, '\\')

// Whether a path, as slashed, is absolute: from `/`, a drive or a share.
export const isAbs = (path: string) => path.startsWith('/') || isWindowsPath(path)

// A folder a command names in Git Bash, `/c/proj`, as Windows spells it, `C:/proj`. Only where the
// session's own folder says the host is Windows: on macOS and Linux `/c` is just a folder.
export const fromShell = (cwd: string, dir: string) =>
  isWindowsPath(cwd) ? dir.replace(/^\/([A-Za-z])(?=\/|$)/, (_, drive: string) => `${drive.toUpperCase()}:`) : dir

export const base = (path: string) => path.slice(path.lastIndexOf('/') + 1)
export const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
export const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)
export const rel = (cwd: string, path: string) => (path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path)
// A folder as the pane prints it: a file outside the project gets its home folder as `~`.
export const where = (dir: string) => dir.replace(/^(?:\/(?:Users|home)|[A-Z]:\/Users)\/[^/]+(?=\/|$)/, '~')
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

// A moment as the pane prints it: the hour and minute on the person's clock.
export const timeOf = (ms: number) => {
  const at = new Date(ms)

  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

export const sizeOf = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// The folder above `dir`, which may climb past the project as `..` segments.
export const parentOf = (dir: string) => {
  if (dir === '' || dir.split('/').every(part => part === '..')) return join(dir, '..')

  return dirOf(dir)
}

// The folder to list, absolute: `dir` under `home`, the project shown. (Listed with no path,
// a host may answer for its own folder rather than the session's.)
export const listPath = (home: string, dir: string) => (dir ? join(home, dir) : home)

export const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
export const firstLine = (text: string) => text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

// The end of a streaming thought or answer, cut at a word: what the card shows of it.
export const tailOf = (text: string, max = 140) => {
  const flat = text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim()

  if (flat.length <= max) return flat

  const cut = flat.slice(-max)

  return `…${cut.slice(cut.indexOf(' ') + 1)}`
}

// The folders above `path` (relative to the project shown) that the tree has not opened, from the
// folder shown down. A file outside the project has none.
export const closedAbove = (old: View, path: string) => {
  if (isAbs(path) || path.startsWith('../')) return []

  const parts = path.split('/').slice(0, -1)

  return parts
    .map((_, i) => parts.slice(0, i + 1).join('/'))
    .filter(dir => (!old.dir || dir.startsWith(`${old.dir}/`)) && !old.expanded.includes(dir))
}

// Whether the tree, showing the folder `dir`, has `path` in it: the project's top shows everything.
export const isUnder = (dir: string, path: string) => !path.startsWith('../') && (dir === '' || path.startsWith(`${dir}/`))

// How well `path` answers a search, as VS Code's quick open ranks: the query's letters in order,
// best in a row, at the start of a word, and in the file's name rather than its folders; shorter
// paths first among equals. Null when the letters are not all there in order.
export const scoreOf = (path: string, query: string): number | null => {
  const text = path.toLowerCase()
  const nameAt = text.lastIndexOf('/') + 1

  // The letters matched in order from `start`, each at the first place it comes next.
  const from = (start: number) => {
    let score = 0
    let at = start - 1
    let run = 0

    for (const letter of query) {
      const found = text.indexOf(letter, at + 1)

      if (found < 0) return null

      run = found === at + 1 ? run + 1 : 0
      score += 1 + run * 2
      if (found === 0 || '/-_. '.includes(text[found - 1]!)) score += 3
      if (found >= nameAt) score += 2
      at = found
    }

    return score
  }

  // Tried from each place the first letter stands, the best kept: `client` in `src/client.js`
  // should not start at the `c` of `src`.
  let best: number | null = null

  for (let start = text.indexOf(query[0] ?? ''); start >= 0; start = text.indexOf(query[0]!, start + 1)) {
    const score = from(start)

    if (score === null) break
    if (best === null || score > best) best = score
  }

  if (best === null) return null

  // The query whole inside the name is what a person most often means.
  if (text.slice(nameAt).includes(query)) best += query.length * 4

  return best - path.length / 100
}

// The paths that answer `query` best, best first.
export const rank = (paths: string[], query: string, limit: number) =>
  paths
    .flatMap(path => {
      const score = scoreOf(path, query)

      return score === null ? [] : [{ path, score }]
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(one => one.path)
