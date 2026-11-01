import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Git, Mark } from '../types'
import { dirOf, join, listPath, slashed } from './paths'
import { DEFAULT_VIEW } from './state'

// The values this file reads or writes. The engine's scan wants each made by `atom` in the file that
// uses it, so every file names its own; state.ts lists the tags they must all share.
const git = atom({ plugin: 'files-pane', key: 'git' } as const, null, { shape: 'git-4' })
const view = atom({ plugin: 'files-pane', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-3' })

// What the pane reads of the disk: git's view of the project shown, folder listings and the file
// index search walks. All of it read-only: listings, and git commands that change nothing, run
// only where the session's own repository is (isTrusted).

export const SKIP = new Set(['.git'])

// A pane draws again only when asked: every write ends with this.
export function redraw($: EngineInterface) {
  return $.ui.invalidate('ui.render')
}

// Git never takes the index lock for the pane (as VS Code runs it), so a read here cannot make
// Claude's own `git commit` fail on `index.lock`.
export function run($: EngineInterface, argv: string[], timeoutMs = 10000, cwd?: string) {
  const [bin, ...args] = argv
  const line = bin === 'git' ? [bin, '--no-optional-locks', ...args] : argv

  return $.process.run(line, { timeoutMs, ...(cwd ? { cwd } : {}) }).catch(() => null)
}

// The session's folder, slashed: every path the pane holds is spelled so (see paths.ts).
export function sessionDir($: EngineInterface) {
  return $.session.cwd().then(slashed)
}

// The folder git names on the first line it prints (`--show-toplevel`, `--absolute-git-dir`),
// slashed; null when it failed or names none.
export const gitPath = (out: Awaited<ReturnType<typeof run>>) => (out && out.exitCode === 0 ? slashed(out.stdout.trim()) || null : null)

// A repository's own config can make git run programs of its choosing (core.fsmonitor, a clean
// filter, a textconv) on `status`, `diff` and `ls-files`, and no flag turns them all off. So
// those run only in the session's own repository, which the person trusted by working in it and
// where Claude Code runs git already: a folder whose git directory is the session folder's. A
// project the tree follows Claude into, or a repository nested inside the session's, gets no git.
// (`rev-parse` reads the config but runs nothing from it.)
const gitDirs = new Map<string, Promise<string | null>>()

function gitDirOf($: EngineInterface, dir: string) {
  let found = gitDirs.get(dir)

  if (!found) {
    // Kept only once git has answered: a run that timed out or could not start asks again next time.
    found = run($, ['git', 'rev-parse', '--absolute-git-dir'], 3000, dir).then(out => {
      if (!out) gitDirs.delete(dir)

      return gitPath(out)
    })
    gitDirs.set(dir, found)
  }

  return found
}

// Whether git may run in `dir` (absolute; the session's folder when empty).
export async function isTrusted($: EngineInterface, dir = ''): Promise<boolean> {
  const cwd = await sessionDir($).catch(() => '')

  if (!cwd) return false
  if (!dir || dir === cwd) return true

  const [own, at] = await Promise.all([gitDirOf($, cwd), gitDirOf($, dir)])

  return own !== null && at === own
}

// Git's NUL-separated output (`-z`), whose paths come raw, never quoted or escaped. A newline
// separates too, so the output of a git that ignored `-z` still reads.
const fieldsOf = (stdout: string | undefined) => (stdout ?? '').split(/\0|\n/)

// The letter for git's two-letter status, `XY` (staged, then in the working tree): a conflict
// first, since both sides changed it, then what happened to the file, or M for a plain change. A
// file added with `git add -N` is ` A`: its A is on the working tree's side.
const markOf = (xy: string): Mark => {
  if (xy === '??') return 'U'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'C'
  if (xy.includes('D')) return 'D'
  if (/[RC]/.test(xy)) return 'R'
  if (xy.includes('A')) return 'A'

  return 'M'
}

// The commit HEAD names in `cwd`, short; null where there is none.
export async function headOf($: EngineInterface, cwd: string) {
  const head = await run($, ['git', 'rev-parse', '--short', 'HEAD'], 5000, cwd)

  return head && head.exitCode === 0 ? head.stdout.trim() || null : null
}

type Entry = Awaited<ReturnType<EngineInterface['fs']['list']>>[number]

// Folder listings, kept between redraws: the pane draws several times a second while Claude
// streams, and the folders have not changed. Keyed by absolute path; a failed listing is not kept.
const listings = new Map<string, Promise<Entry[]>>()

export function listDir($: EngineInterface, path: string) {
  let listing = listings.get(path)

  if (!listing) {
    listing = $.fs.list(path).catch(() => {
      listings.delete(path)

      return []
    })
    listings.set(path, listing)
  }

  return listing
}

// The branch, and where the folder sits in its repository (`sub/`, or nothing at the top); null
// outside a repository. `--abbrev-ref` reads HEAD's commit, which a repository without one yet does
// not have: then the branch is the one HEAD names. A detached HEAD names no branch, only its commit.
async function placeOf($: EngineInterface, at: string | undefined) {
  const head = await run($, ['git', 'rev-parse', '--abbrev-ref', 'HEAD', '--show-prefix'], 5000, at)

  if (head && head.exitCode === 0) {
    const [branch = '', prefix = ''] = head.stdout.split('\n')

    return { branch: branch === 'HEAD' ? ((await headOf($, at ?? '')) ?? branch) : branch, prefix }
  }

  const [unborn, place] = await Promise.all([
    run($, ['git', 'symbolic-ref', '--short', '-q', 'HEAD'], 5000, at),
    run($, ['git', 'rev-parse', '--show-prefix'], 5000, at),
  ])

  if (!unborn || unborn.exitCode !== 0 || !place || place.exitCode !== 0) return null

  return { branch: unborn.stdout.trim(), prefix: place.stdout.split('\n')[0] ?? '' }
}

// Git as the project shown sees it: `root`, or the session's folder when empty. Paths come
// relative to that folder, as the tree spells them.
async function readGit($: EngineInterface, root: string): Promise<Git | null> {
  if (root && !(await isTrusted($, root))) return null

  const at = root || undefined
  const where = await placeOf($, at)

  if (!where) return null

  const { branch, prefix } = where
  const [state, numstat, ahead, ignored] = await Promise.all([
    run($, ['git', 'status', '--porcelain', '-z', '-uall'], 10000, at),
    run($, ['git', 'diff', '--numstat', '-z', '--relative', 'HEAD'], 10000, at),
    run($, ['git', 'rev-list', '--count', '@{u}..HEAD'], 5000, at),
    // `--directory` names an ignored folder once, as `node_modules/`, not every file in it.
    run($, ['git', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], 10000, at),
  ])

  // `XY path` from the repository's top; a rename or a copy names where it came from next.
  const changed: string[] = []
  const marks: Record<string, Mark> = {}
  const states = fieldsOf(state?.stdout)

  for (let i = 0; i < states.length; i++) {
    const field = states[i]!

    if (field.length < 4) continue
    if (/^[RC]/.test(field)) i++

    const path = field.slice(3)

    if (path.startsWith(prefix)) {
      changed.push(path.slice(prefix.length))
      marks[path.slice(prefix.length)] = markOf(field.slice(0, 2))
    }
  }

  // `added removed path`, or for a rename `added removed` and then its old and new paths.
  const lines: Record<string, [number, number]> = {}
  const counts = fieldsOf(numstat?.stdout)

  for (let i = 0; i < counts.length; i++) {
    const [added, removed, named] = counts[i]!.split('\t')

    if (named === undefined) continue

    const path = named === '' ? counts[(i += 2)] : named

    // A binary file counts as `-`: it has no lines to show.
    if (path && /^\d+$/.test(added ?? '') && /^\d+$/.test(removed ?? '')) lines[path] = [Number(added), Number(removed)]
  }

  return {
    branch: branch.trim(),
    ahead: ahead && ahead.exitCode === 0 ? Number(ahead.stdout.trim()) || 0 : null,
    changed,
    marks,
    lines,
    ignored: fieldsOf(ignored?.stdout).filter(Boolean).slice(0, 2000),
  }
}

// Reads git again for the project shown. A call while a read runs is folded into one more read
// after it, so a burst of tool calls costs two reads, not one each.
let reading: Promise<void> | null = null
let isStale = false

export function refreshGit($: EngineInterface): Promise<void> {
  if (reading) {
    isStale = true

    return reading
  }

  // Never rejects: callers start it without waiting, and a session that has ended answers nothing.
  reading = (async () => {
    do {
      isStale = false
      const next = await readGit($, (await read($, view)).root)
      await update($, git, () => next)
      redraw($)
    } while (isStale)
  })()
    .catch(() => {})
    .finally(() => {
      reading = null
    })

  return reading
}

// Every file in the project shown, for search: git's list, else a bounded walk.
let fileIndex: string[] | null = null
let fileIndexRoot = ''

// `home` is the project shown, absolute.
export async function indexFiles($: EngineInterface, home: string): Promise<string[]> {
  if (fileIndex && fileIndexRoot === home) return fileIndex

  fileIndexRoot = home
  const listed = (await isTrusted($, home)) ? await run($, ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], 10000, home) : null

  if (listed && listed.exitCode === 0) {
    fileIndex = fieldsOf(listed.stdout).filter(Boolean)

    return fileIndex
  }

  const found: string[] = []
  const queue = ['']

  while (queue.length > 0 && found.length < 5000) {
    const dir = queue.shift()!
    const entries = await $.fs.list(listPath(home, dir)).catch(() => [])

    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.name === 'node_modules') continue
      if (entry.kind === 'dir') queue.push(join(dir, entry.name))
      else found.push(join(dir, entry.name))
    }
  }

  fileIndex = found

  return found
}

// What the pane holds of the disk, dropped whenever it may have changed: search's index and the
// tree's listings.
export const forget = () => {
  fileIndex = null
  listings.clear()
}

// A diff the pane shows whole up to this many lines; past it, cut where a hunk ends.
const DIFF_LINES = 400

// Lines Code draws: no control character but tab and newline.
const printable = (line: string) => line.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')

// A hunk's header counted again for the lines kept of it, so a hunk cut short still parses.
const recount = (hunk: string[]) => {
  const [, from = '0', to = '0', rest = ''] = hunk[0]!.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/) ?? []
  const body = hunk.slice(1)
  const old = body.filter(line => !line.startsWith('+')).length
  const next = body.filter(line => !line.startsWith('-')).length

  return [`@@ -${from},${old} +${to},${next} @@${rest}`, ...body]
}

// What changed in a file since HEAD, as unified-diff hunks with two lines around each change; a
// file git does not track yet, or any file before the first commit, whole, as added lines. Past
// DIFF_LINES the rest is left out, and counted.
// None outside the session's repository: see isTrusted.
export async function diffOf($: EngineInterface, abs: string): Promise<{ text: string; more: number }> {
  const dir = dirOf(abs)

  if (!(await isTrusted($, dir))) return { text: '', more: 0 }

  const [tracked, head] = await Promise.all([run($, ['git', 'ls-files', '--error-unmatch', '--', abs], 5000, dir), headOf($, dir)])
  const argv =
    tracked && tracked.exitCode === 0 && head !== null
      ? ['git', 'diff', '--no-color', '--no-ext-diff', '-U2', 'HEAD', '--', abs]
      : ['git', 'diff', '--no-color', '--no-ext-diff', '-U2', '--no-index', '--', '/dev/null', abs]
  // `--no-index` exits 1 when the files differ, which they always do: its output is what counts.
  const out = (await run($, argv, 10000, dir))?.stdout ?? ''
  const all = out.split('\n').map(printable)
  const start = all.findIndex(line => line.startsWith('@@'))

  if (start < 0) return { text: '', more: 0 }

  const lines = all.slice(start)

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length <= DIFF_LINES) return { text: lines.join('\n'), more: 0 }

  // Cut where the last hunk that starts in room begins; a first hunk too long for the room is
  // cut inside, its header counted again.
  const lastStart = lines.slice(0, DIFF_LINES + 1).findLastIndex(line => line.startsWith('@@'))
  const kept = lastStart > 0 ? lines.slice(0, lastStart) : recount(lines.slice(0, DIFF_LINES))

  return { text: kept.join('\n'), more: lines.length - kept.length }
}
