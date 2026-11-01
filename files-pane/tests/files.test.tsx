import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { SVGS } from '../hooks/icon-svgs'
import { fileIcon, folderIcon } from '../hooks/icons'
import { rowsOf } from '../hooks/diff'
import { EDIT } from '../hooks/look'
import { rank, timeOf } from '../hooks/paths'
import { LOGGED_RETRY_AND_SLOWER_DELAY } from './git-diffs'

const PANE = {
  plugin: 'files-pane',
  component: 'Pane',
  requestId: 'files-pane',
  props: {
    title: 'Files: proj',
    isFocused: false,
    bodyColumns: 48,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const entry = (name: string, kind: 'file' | 'dir', size = 0) => ({ name, kind, size, mtimeMs: 0, isLink: false })

// The folder the pane listed, as it asked for it. The test engine resolves a listing against the
// system it runs on, and on Windows `/proj` comes as `D:\proj`.
const asked = (path: string) => path.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

// What git answers in the engine below. `dirty` is what it reports as changed (`git status -z`
// fields), so a test can commit by emptying it; a commit moves HEAD to a1c9e42 unless `isRefused`,
// as a failing hook would. `diff` is what `git diff` prints for a file.
type GitWorld = { dirty: string[]; ahead: string; head?: string; shown?: string; isRefused?: boolean; diff?: string }

// Each hook stands for the engine: a project at /proj with src/ and tests/, on branch main.
// `ran` collects every command git is asked, with the folder it runs in.
const engine = (
  on: Parameters<TestBody>[1],
  git: GitWorld = { dirty: [' M src/client.js'], ahead: '0' },
  registered: string[] = [],
  ran: { argv: string[]; cwd?: string }[] = [],
) => {
  on('command.register', (_, e) => {
    registered.push((e as { name: string }).name)

    return { value: { command: 'files' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', (_, e) => {
    if (/\bcommit\b/.test((e as { command?: string }).command ?? '') && !git.isRefused) git.head = 'a1c9e42'

    return { result: {} }
  })
  on('fs.list', (_, e) => {
    const path = (e as { path?: string }).path ?? ''

    if (path.endsWith('src')) return { value: [entry('client.js', 'file', 2048)] }

    return { value: [entry('README.md', 'file', 10), entry('src', 'dir'), entry('tests', 'dir'), entry('.env', 'file')] }
  })
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { cwd?: string } }
    ran.push({ argv, cwd: init?.cwd })
    const stdout = argv.includes('--abbrev-ref')
      ? 'main\n'
      : argv.includes('--absolute-git-dir')
        ? '/proj/.git\n'
      : argv.includes('--short') && argv.includes('rev-parse')
        ? `${git.head ?? '9f3b210'}\n`
        : argv.includes('status')
          ? git.dirty.map(line => `${line}\0`).join('')
          : argv.includes('diff') && !argv.includes('--numstat')
            ? (git.diff ?? 'diff --git a/src/client.js b/src/client.js\n--- a/src/client.js\n+++ b/src/client.js\n@@ -1 +1 @@\n-a\n+b\n')
          : argv.includes('--numstat')
            ? git.dirty.length > 0 ? '1\t1\tsrc/client.js\n' : ''
            : argv.includes('rev-list')
              ? `${git.ahead}\n`
              : argv.includes('show')
                ? `${git.shown ?? 'src/client.js'}\n`
                : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

// Lets what the pane started without waiting (a read of git) run to its end.
const settled = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const text = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<{ text?: string } | undefined> }, pattern: RegExp) =>
  (await ui.find({ type: 'Text', text: pattern }))?.text

// Every text the pane draws, in order, as a person reads it: each one's padding off, a space between.
const reading = async (ui: { findAll: (q: { type: string }) => Promise<unknown> }) =>
  ((await ui.findAll({ type: 'Text' })) as { text?: string }[])
    .map(one => (one.text ?? '').replace(/ /g, ' ').trim())
    .filter(Boolean)
    .join(' ')

// The folders' chevrons on a surface that paints, as each one's alt names it: `open` or `closed`.
const chevrons = async (ui: { findAll: (q: { type: string }) => Promise<unknown> }) =>
  ((await ui.findAll({ type: 'Svg' })) as { props: { alt: string } }[]).map(one => one.props.alt).filter(alt => alt === 'open' || alt === 'closed')

test('a read shows in the card and the touched list, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/tests/client.test.js' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })

    // After the read, Claude is between tools: the card says it is thinking, and what it opened.
    expect(await text(ui, /^Claude is thinking$/)).toBe('Claude is thinking')
    expect(await text(ui, /^opened 1 file$/)).toBe('opened 1 file')
    expect(await text(ui, /^client\.test\.js$/)).toBe('client.test.js')
    expect(await text(ui, /^ ?Opened ?$/)).toBeUndefined()
    expect(await text(ui, /^CLAUDE TOUCHED$/)).toBe('CLAUDE TOUCHED')
    expect(await text(ui, /^ ?1 file ?$/)).toMatch(/1 file/)
    expect(await text(ui, /1 changed/)).toMatch(/1 changed/)
    expect(await text(ui, /^ ?proj ?$/)).toMatch(/proj/)
    await ui.unmount()
  }
})

test('a finished turn says what Claude edited, with its line counts', async ($, on) => {
  engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^DONE$/)).toBe('DONE')
  expect(await text(ui, /^Claude edited 1 file$/)).toBe('Claude edited 1 file')
  expect(await text(ui, /^src\/client\.js/)).toMatch(/^src\/client\.js \+1 −1/)
  expect(await text(ui, /^ ?Edited ?$/)).toBeUndefined()
  expect(await text(ui, /Not committed/)).toMatch(/Not committed/)
  await ui.unmount()
})

test('a commit turns the card, the rows and the foot green', async ($, on) => {
  const git = { dirty: [' M src/client.js'], ahead: '0' }
  engine(on, git)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })
  git.dirty = []
  git.ahead = '1'
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "Raise MAX_RETRIES to 3"' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Claude committed 1 file$/)).toBe('Claude committed 1 file')
  expect(await text(ui, /^a1c9e42$/)).toBe('a1c9e42')
  expect(await text(ui, /^ ?Committed ?$/)).toBeUndefined()
  expect(await text(ui, /^↑1$/)).toBe('↑1')
  expect(await text(ui, /clean, nothing changed/)).toBe('clean, nothing changed')
  expect(await text(ui, /committed a1c9e42/)).toMatch(/committed a1c9e42/)
  await ui.unmount()
})

test('a commit a hook refuses leaves HEAD alone, and nothing turns green', async ($, on) => {
  const git: GitWorld = { dirty: [' M src/client.js'], ahead: '0', isRefused: true }
  engine(on, git)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "Raise MAX_RETRIES to 3"' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Claude committed/)).toBeUndefined()
  expect(await text(ui, /^9f3b210$/)).toBeUndefined()
  expect(await text(ui, /^ ?committ(ing|ed \w+) ?$/)).toBeUndefined()
  await ui.unmount()
})

test('a commit with -C is read from that repository', async ($, on) => {
  const git: GitWorld = { dirty: [], ahead: '0', shown: 'lib/util.ts' }
  const ran: { argv: string[]; cwd?: string }[] = []
  engine(on, git, [], ran)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/work/other/lib/util.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git -C /work/other commit -am "Fix util"' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Claude committed 1 file$/)).toBe('Claude committed 1 file')
  expect(ran.some(one => one.argv.includes('show') && one.cwd === '/work/other')).toBe(true)
  await ui.unmount()
})

test('a redraw does not list the tree again; a command does', async ($, on) => {
  const listed: string[] = []
  world(on, { '/proj': [entry('src', 'dir')], '/proj/src': [entry('a.ts', 'file')] }, undefined, listed)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const first = listed.length

  await ui.press({ key: 'refresh' })
  const afterRefresh = listed.length
  await ui.press({ key: 'sizes' })
  expect(listed.length).toBe(afterRefresh)
  expect(afterRefresh).toBeGreaterThan(first)

  await $.tool.call({ tool: 'Bash', command: 'touch b.ts' })
  await ui.press({ key: 'sizes' })
  expect(listed.length).toBeGreaterThan(afterRefresh)
  await ui.unmount()
})

test('the first turn sets up /files when session.start never reached the mod', async ($, on) => {
  const registered: string[] = []
  engine(on, undefined, registered)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.turn.start({ turnId: 't1', prompt: 'hi' } as never)
  await $.turn.start({ turnId: 't2', prompt: 'again' } as never)

  expect(registered).toEqual(['files'])
})

test('the tree shows hidden files until asked, and opens a folder', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^\.env$/)).toBe('.env')
  expect(await text(ui, /^client\.js$/)).toBeUndefined()

  await ui.press({ key: 'dir:src' })
  expect(await text(ui, /^client\.js$/)).toBe('client.js')
  // The desktop draws the vscode-icons JavaScript icon where the terminal draws a chip.
  const icons = (await ui.findAll({ type: 'Svg' })) as unknown as { props: { source: string; alt: string } }[]
  expect(icons.some(one => one.props.source === fileIcon('client.js'))).toBe(true)
  // The desktop drops an Svg whose alt is empty, so every icon must name itself.
  expect(icons.filter(one => one.props.alt.trim() === '')).toHaveLength(0)
  expect(await text(ui, /^ JS $/)).toBeUndefined()

  await ui.press({ key: 'hidden' })
  expect(await text(ui, /^\.env$/)).toBeUndefined()
  await ui.unmount()
})

test('a file keeps the chevron space only beside a folder', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const blanks = async () => ((await ui.findAll({ type: 'Svg' })) as unknown as { props: { alt: string } }[]).filter(one => one.props.alt === 'file')

  // README.md and .env sit beside src/ and tests/, as the .. row above them does; client.js has
  // no folder beside it in src/.
  await ui.press({ key: 'dir:src' })
  expect(await text(ui, /^client\.js$/)).toBe('client.js')
  expect(await blanks()).toHaveLength(3)
  await ui.unmount()
})

test('the terminal shows a chip for a file type, and a folder outside the project from ~', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/Users/someone/notes/plan.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await text(ui, /^MD +$/)).toBe('MD  ')
  expect(await text(ui, /^~\/notes$/)).toBe('~/notes')
  await ui.unmount()
})

// The terminal draws a color's alpha byte as if it were opaque: a tint there is a solid block in the
// color of the text on it, which hides the text. So no color the terminal is handed has one.
test('the terminal gets no see-through color, and its type chips share one width', async ($, on) => {
  engine(on, { dirty: [' M src/client.js'], ahead: '2' })
  await $.session.start({ cwd: '/proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await settled()

  const seeThrough = (props: unknown): string[] =>
    Object.entries(props && typeof props === 'object' ? props : {}).flatMap(([key, value]) =>
      typeof value === 'string' ? (/color$/i.test(key) && /^#[0-9a-f]{8}$/i.test(value) ? [`${key} ${value}`] : []) : seeThrough(value),
    )
  const drawn = (await ui.findAll({})) as unknown as { type: string; props: Record<string, unknown>; text: string }[]

  expect(drawn.flatMap(one => seeThrough(one.props))).toEqual([])

  // README.md's, .env's and client.js's: the names after them start in one column.
  const chips = drawn.filter(one => one.type === 'Text' && one.props.mono && one.props.weight === 'semibold').map(one => one.text)

  expect(chips.length).toBeGreaterThanOrEqual(3)
  expect(new Set(chips.map(one => one.length)).size).toBe(1)
  await ui.unmount()
})

test('icons follow VS Code: an exact name, then the longest extension, then a default', () => {
  expect(fileIcon('package.json')).toBe(SVGS['file-type-npm'])
  expect(fileIcon('types.d.ts')).toBe(SVGS['file-type-typescriptdef'])
  expect(fileIcon('Button.tsx')).toBe(SVGS['file-type-reactts'])
  expect(fileIcon('vite.config.ts')).toBe(SVGS['file-type-vite'])
  expect(fileIcon('mystery.zzz')).toBe(SVGS['default-file'])
  expect(folderIcon('src', true)).toBe(SVGS['folder-type-src-opened'])
  expect(folderIcon('whatever', false)).toBe(SVGS['default-folder'])
})

test('a file Claude reads opens no folder: only a press on its name does', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/client.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const count = async () => ((await ui.findAll({ type: 'Text', text: /^client\.js$/ })) as unknown as unknown[]).length

  // Only the touched list names it: src stays closed.
  expect(await count()).toBe(1)
  expect(await chevrons(ui)).not.toContain('open')

  await ui.press({ key: 'dir:src' })
  expect(await count()).toBe(2)
  expect(await chevrons(ui)).toContain('open')
  await ui.unmount()
})

// A second world for the tests below: a tree by absolute folder, git's top level for folders outside /proj,
// and a tool call that can be held open while the test looks. `listed` collects every folder listed.
const world = (on: Parameters<TestBody>[1], tree: Record<string, ReturnType<typeof entry>[]>, hold?: Promise<void>, listed: string[] = []) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', async () => {
    await hold

    return { result: {} }
  })
  on('fs.list', (_, e) => {
    const path = asked((e as { path: string }).path)
    listed.push(path)

    return { value: tree[path] ?? [] }
  })
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { cwd?: string } }
    const cwd = init?.cwd
    const stdout = argv.includes('--show-toplevel') ? (cwd?.startsWith('/work/other') ? '/work/other\n' : '/proj\n') : argv.includes('--abbrev-ref') ? 'main\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

test('the tree follows Claude into another project and back', async ($, on) => {
  world(on, {
    '/proj': [entry('home.ts', 'file')],
    '/work/other': [entry('lib', 'dir')],
    '/work/other/lib': [entry('util.ts', 'file')],
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/work/other/lib/util.ts', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The tree lists the other project, opened down to the edited file, and offers the way home.
  expect(await text(ui, /^ ?other ?$/)).toMatch(/other/)
  expect(await text(ui, /^lib$/)).toBe('lib')
  expect(await chevrons(ui)).toContain('open')
  expect(await text(ui, /^home\.ts$/)).toBeUndefined()

  await ui.press({ key: 'home' })
  expect(await text(ui, /^home\.ts$/)).toBe('home.ts')
  await ui.unmount()
})

test('the card says what Claude is doing with a tool other than a read or an edit', async ($, on) => {
  let release = () => {}
  const hold = new Promise<void>(resolve => (release = resolve))
  world(on, {}, hold)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const call = $.tool.call({ tool: 'Bash', command: 'npm test -- --watch=false', description: 'Run the tests' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Run the tests$/)).toBe('Run the tests')
  expect(await text(ui, /^npm test/)).toMatch(/^npm test/)

  release()
  await call
  await ui.unmount()
})

test('the card shows the tail of what Claude is thinking as it streams', async ($, on) => {
  world(on, {})
  on('turn.step', async function* () {
    yield { kind: 'thinking', index: 0, text: 'The retry should back off, ' } as never
    yield { kind: 'thinking', index: 0, text: 'so I will check client.ts first.' } as never

    return { turnId: 't1', index: 0, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as never
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'test', messageCount: 1 } as never) as never as AsyncIterable<unknown>) {
    // Drain the stream as the engine would.
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Claude is thinking$/)).toBe('Claude is thinking')
  expect(await text(ui, /back off/)).toMatch(/back off/)
  // The last piece came within the spacing of the first: it is shown when the step ends.
  expect(await text(ui, /client\.ts first/)).toMatch(/client\.ts first/)
  await ui.unmount()
})

test('a quick read stays on the card a moment, not a flash', async ($, on) => {
  const clock = mock.clock(on)
  world(on, { '/proj': [entry('a.ts', 'file')] })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await clock.advance(1000)
  await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The read is over, but the card holds it before it says Claude is thinking again.
  expect(await text(ui, /^Claude is reading a\.ts$/)).toBe('Claude is reading a.ts')

  await clock.advance(800)
  expect(await text(ui, /^Claude is thinking$/)).toBe('Claude is thinking')
  await ui.unmount()
})

test('a file Claude edits opens its folders, so the change is in sight', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The touched list and the opened tree both name it.
  expect(((await ui.findAll({ type: 'Text', text: /^client\.js$/ })) as unknown as unknown[]).length).toBe(2)
  expect(await chevrons(ui)).toContain('open')
  await ui.unmount()
})

test('a folder the person opened stays open when Claude opens another', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  // The person opens tests/ on a drawing made before Claude's edit opens src/.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })
  await ui.press({ key: 'dir:tests' })

  expect((await chevrons(ui)).filter(one => one === 'open')).toHaveLength(2)
  await ui.unmount()
})

test('an edit outside the folder the tree shows takes it back to the top, opened down to the file', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  // The .. row from the project's top shows its parent, with the way home in the header; Claude
  // then edits a file in src/.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await text(ui, /⌂ Project/)).toBeUndefined()
  await ui.press({ key: 'up' })
  expect(await text(ui, /⌂ Project/)).toMatch(/Project/)
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  expect(await text(ui, /^ ?proj ?$/)).toMatch(/proj/)
  expect(await chevrons(ui)).toContain('open')
  await ui.unmount()
})

// A drawn element as the kit hands it back, its children described the same way.
type Drawn = { type: string; key?: string; props: Record<string, unknown>; text?: string; children: (Drawn | string)[] }

// The elements from `from` down to the first whose own text matches `pattern`, `from` first.
const pathTo = (from: Drawn, pattern: RegExp): Drawn[] | null => {
  if (from.type === 'Text' && pattern.test(from.children.join(''))) return [from]

  for (const child of from.children) {
    const below = typeof child === 'string' ? null : pathTo(child, pattern)

    if (below) return [from, ...below]
  }

  return null
}

test('a folder name wider than the pane gives way in the header, cut with an ellipsis', async ($, on) => {
  const long = 'a-folder-name-far-too-long-for-any-narrow-pane'
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: `/work/${long}` }))
  on('tool.call', () => ({ result: {} }))
  on('fs.list', () => ({ value: [entry('notes.md', 'file')] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  await $.session.start({ cwd: `/work/${long}`, surface: 'desktop', isInteractive: true })

  // Every Box between the header and the name may shrink below its content, and the name ends in
  // an ellipsis where it is cut.
  const givesWay = async (ui: { findAll: (q: { type: string }) => Promise<unknown> }) => {
    const rows = (await ui.findAll({ type: 'Box' })) as Drawn[]
    const header = rows.find(one => one.props.justifyContent === 'space-between' && /^ALL FILES/.test(one.text ?? ''))!
    const [, ...boxes] = pathTo(header, new RegExp(long))!
    const name = boxes.pop()!

    expect(boxes.map(one => [one.props.flexShrink ?? 1, one.props.minWidth])).toEqual(boxes.map(() => [1, 0]))
    expect(name.props.wrap).toBe('truncate-end')
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    // The project's own name, at its top.
    const ui = await $.ui.mount({ ...PANE, surface })
    await givesWay(ui)
    await ui.unmount()
  }

  // A file Claude writes outside the project takes the tree to its folder, named beside the way
  // home, which stays whole.
  await $.tool.call({ tool: 'Write', file_path: `/notes/${long}/notes.md`, content: '' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await givesWay(ui)
    expect((await ui.find({ key: 'chip:home' }))?.props.flexShrink).toBe(surface === 'desktop' ? 0 : undefined)
    await ui.unmount()
  }
})

test('a press anywhere on a folder row opens it and closes it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The overlay draws no label: the desktop would paint it as text over the chevron and the icon.
  const buttons = (await ui.findAll({ type: 'Button' })) as unknown as { props: { key?: string; label?: string } }[]
  const overlays = buttons.filter(one => one.props.key?.startsWith('fold:'))
  expect(overlays.length).toBeGreaterThan(0)
  expect(overlays.filter(one => (one.props.label ?? '').trim() !== '')).toEqual([])
  // The desktop cuts its blank text short with an ellipsis, so the layer reaches past the row's
  // end, where the row clips the ellipsis away.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { props: { position?: string; right?: number }; children?: unknown[] }[]
  const layers = boxes.filter(one => one.props.position === 'absolute' && (one.props.right ?? 0) < 0)
  expect(layers.length).toBeGreaterThanOrEqual(overlays.length)

  await ui.press({ key: 'fold:src' })
  expect(await text(ui, /^client\.js$/)).toBe('client.js')
  await ui.press({ key: 'fold:src' })
  expect(await text(ui, /^client\.js$/)).toBeUndefined()
  await ui.unmount()
})

test('VS Code lays nothing over a row: a folder opens from its caret, and its name is text', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'vscode', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })

  // Its webview places no absolute Box and fills every Button, so a press layer, a shimmer or a
  // folder's name as a Button would each draw as a filled bar of its own.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { props: { position?: string } }[]
  expect(boxes.filter(one => one.props.position === 'absolute')).toEqual([])
  const keys = ((await ui.findAll({ type: 'Button' })) as unknown as { props: { key?: string } }[]).map(one => one.props.key ?? '')
  expect(keys.filter(key => /^(fold|dir|away):/.test(key) || key === 'up:row')).toEqual([])
  expect(await text(ui, /^src$/)).toBe('src')

  await ui.press({ key: 'caret:src' })
  expect(await text(ui, /^client\.js$/)).toBe('client.js')
  await ui.press({ key: 'caret:src' })
  expect(await text(ui, /^client\.js$/)).toBeUndefined()
  await ui.unmount()
})

test('git names a renamed file once, from the new name it reports first', async ($, on) => {
  engine(on, { dirty: ['R  src/client.js', 'src/old-client.js', '?? notes/a file with spaces.md'], ahead: '0' })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^ ?2 changed ?$/)).toMatch(/2 changed/)
  await ui.unmount()
})

test('a command makes the pane read git again; a web search does not', async ($, on) => {
  const ran: { argv: string[]; cwd?: string }[] = []
  engine(on, undefined, [], ran)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  // The read the pane makes as it starts, out of the way.
  await settled()

  const reads = () => ran.filter(one => one.argv.includes('status')).length
  const before = reads()

  await $.tool.call({ tool: 'WebSearch', query: 'retry backoff', mode: 'standard' })
  await settled()
  expect(reads()).toBe(before)

  await $.tool.call({ tool: 'Bash', command: 'touch notes.md', description: 'Make a note' })
  await settled()
  expect(reads()).toBeGreaterThan(before)
})

test('two commands at once: the card shows the one still running when the other ends', async ($, on) => {
  const holds: Record<string, () => void> = {}
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('fs.list', () => ({ value: [] }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', async (_, e) => {
    await new Promise<void>(resolve => (holds[(e as { description: string }).description] = resolve))

    return { result: {} }
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const first = $.tool.call({ tool: 'Bash', command: 'npm run lint', description: 'Lint' })
  const second = $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Test' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  holds.Lint!()
  await first
  expect(await text(ui, /^Test$/)).toBe('Test')

  holds.Test!()
  await second
  expect(await text(ui, /^Claude is thinking$/)).toBe('Claude is thinking')
  await ui.unmount()
})

test('a file committed where Claude did not see it offers no diff', async ($, on) => {
  const git: GitWorld = { dirty: [' M src/client.js'], ahead: '0' }
  engine(on, git)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^Diff$/)).toBe('Diff')
  await ui.press({ key: 'more:touched:/proj/src/client.js' })

  // Committed in another session, or by the app: git has nothing left to show for the file.
  git.dirty = []
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  await settled()

  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')
  expect(await text(ui, /^Diff$/)).toBeUndefined()
  await ui.unmount()
})

test('the ⋯ on a file opens its actions; Diff shows what changed, and hides it again', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const view = async () => ui.find({ key: 'diffview:touched:/proj/src/client.js' } as never)

  expect(await text(ui, /^@ Mention$/)).toBeUndefined()

  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')
  expect(await view()).toBeUndefined()
  // A popover over the row above, which moves no row.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { props: { key?: string; position?: string } }[]
  expect(boxes.find(one => one.props.key === 'actions:touched:/proj/src/client.js')?.props.position).toBe('absolute')

  await ui.press({ key: 'diff:touched:/proj/src/client.js' })
  expect(await view()).toBeDefined()
  // A row a line, numbered, under the hunk's own: git's header lines are left to the file's row.
  expect(await text(ui, /^Line 1$/)).toBe('Line 1')
  expect(await text(ui, /^−$/)).toBe('−')
  expect(await text(ui, /^a$/)).toBe('a')
  expect(await text(ui, /^b$/)).toBe('b')
  expect(await text(ui, /^diff --git/)).toBeUndefined()

  await ui.press({ key: 'diff:touched:/proj/src/client.js' })
  expect(await view()).toBeUndefined()

  // The ⋯ again closes the actions.
  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBeUndefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a press elsewhere in the pane closes a file's actions, and still does its own work (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ ...PANE, surface })
    const more = 'more:touched:/proj/src/client.js'

    // The menu's own rows keep it open.
    await ui.press({ key: more })
    await ui.press({ key: 'copy:touched:/proj/src/client.js' })
    expect(await text(ui, /^Absolute path$/)).toBe('Absolute path')

    // Another control closes it, and acts: the sizes show (README.md's; a changed file shows its line counts).
    await ui.press({ key: 'sizes' })
    expect(await text(ui, /^@ Mention$/)).toBeUndefined()
    expect(await text(ui, /^10 B$/)).toBe('10 B')
    await ui.unmount()
  })
}

test('on a surface that paints, a press anywhere on a menu row or on another file row counts', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const buttons = async () => ((await ui.findAll({ type: 'Button' })) as unknown as { props: { key?: string } }[]).map(one => one.props.key ?? '')

  expect((await buttons()).filter(key => key.startsWith('away:'))).toEqual([])
  await ui.press({ key: 'more:touched:/proj/src/client.js' })

  // Each menu row is a layer of blank text over the whole row, its label plain text beneath.
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as { props: { key?: string; overflow?: string } }[]
  expect(boxes.find(one => one.props.key === 'item:mention:touched:/proj/src/client.js')?.props.overflow).toBe('hidden')
  expect(await buttons()).toContain('mention:touched:/proj/src/client.js')

  // A press on a file row away from the menu closes it.
  expect(await buttons()).toContain('away:tree:/proj/src/client.js')
  await ui.press({ key: 'away:tree:/proj/README.md' })
  expect(await text(ui, /^@ Mention$/)).toBeUndefined()
  expect((await buttons()).filter(key => key.startsWith('away:'))).toEqual([])
  await ui.unmount()
})

test('with a file’s actions open, every layer that reaches past its row is clipped by it', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'more:tree:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')

  // A layer left unclipped lights past the pane's edge under the pointer.
  type Node = { type?: string; props: { position?: string; right?: number; overflow?: string }; children?: unknown[] }
  const boxes = (await ui.findAll({ type: 'Box' })) as unknown as Node[]
  const isLayer = (one: unknown) => (one as Node | null)?.props?.position === 'absolute' && ((one as Node).props.right ?? 0) < 0
  const holders = boxes.filter(one => (one.children ?? []).some(isLayer))
  expect(holders.length).toBe(boxes.filter(isLayer).length)
  expect(holders.filter(one => one.props.overflow !== 'hidden')).toEqual([])
  await ui.unmount()
})

test('a press on a plain part of the pane closes a file’s actions', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  for (const part of ['away:card', 'away:branch', 'away:legend', 'away:head:CLAUDE TOUCHED']) {
    await ui.press({ key: 'more:touched:/proj/src/client.js' })
    expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')
    await ui.press({ key: part })
    expect(await text(ui, /^@ Mention$/)).toBeUndefined()
  }
  await ui.unmount()
})

test('a click away from the pane, which takes the keyboard from it, closes a file’s actions', async ($, on) => {
  engine(on)
  const clock = mock.clock(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const focused = { ...PANE.props, isFocused: true }
  const ui = await $.ui.mount({ ...PANE, props: focused, surface: 'desktop' })

  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')

  await ui.redraw({ ...focused, isFocused: false })
  await clock.settle()
  expect(await text(ui, /^@ Mention$/)).toBeUndefined()

  // A menu opened in a pane that never held the keyboard stays open.
  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  await ui.redraw({ ...focused, isFocused: false })
  await clock.settle()
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')
  await ui.unmount()
})

test('typing in the prompt closes a file’s actions', async ($, on) => {
  engine(on)
  on('prompt.edit', (_, e) => ({ text: e.text + e.inputText, cursor: e.cursor + e.inputText.length }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  expect(await text(ui, /^@ Mention$/)).toBe('@ Mention')

  // The person's keys raise it; a plugin's `$` has no call for it, so the test reaches it untyped.
  const prompt = $.prompt as unknown as { edit: (e: unknown) => Promise<unknown> }
  await prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'h' })
  expect(await text(ui, /^@ Mention$/)).toBeUndefined()
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  // The name says what Claude did with a file and the letter what git sees in it, so neither hides
  // the other: an edited file Claude has not committed is orange and marked M.
  test(`a changed file carries git's letter beside Claude's color (${surface})`, async ($, on) => {
    engine(on, { dirty: [' M src/client.js', '?? .env', 'A  README.md'], ahead: '0' })
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ ...PANE, surface })
    await settled()

    const names = (await ui.findAll({ type: 'Text', text: /^client\.js$/ })) as unknown as { props: { color?: string } }[]
    const marks = async (letter: string) => ((await ui.findAll({ type: 'Text', text: new RegExp(`^${letter}$`) })) as unknown as unknown[]).length

    // In the touched list and in the tree.
    expect(names.map(one => one.props.color)).toEqual([EDIT, EDIT])
    expect(await marks('M')).toBe(2)
    expect(await marks('U')).toBe(1)
    expect(await marks('A')).toBe(1)
    await ui.unmount()
  })

  test(`the touched list says when Claude first touched each file (${surface})`, async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })

    const before = timeOf(Date.now())
    await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
    const after = timeOf(Date.now())

    const ui = await $.ui.mount({ ...PANE, surface })

    expect([before, after]).toContain(await text(ui, /^\d\d:\d\d$/))
    await ui.unmount()
  })

  test(`a press on "N changed" opens the tree to every changed file (${surface})`, async ($, on) => {
    engine(on, { dirty: [' M src/client.js', ' M README.md'], ahead: '0' })
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })

    const ui = await $.ui.mount({ ...PANE, surface })
    await settled()
    expect(await text(ui, /^client\.js$/)).toBeUndefined()

    await ui.press({ key: 'changed' })
    expect(await text(ui, /^client\.js$/)).toBe('client.js')
    await ui.unmount()
  })
}

test('a diff of several hunks reads line by line, each numbered where it is in the file', async ($, on) => {
  engine(on, { dirty: [' M src/client.js'], ahead: '0', diff: LOGGED_RETRY_AND_SLOWER_DELAY })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'ms', new_string: 'ms * 2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  await ui.press({ key: 'diff:touched:/proj/src/client.js' })
  const read = await reading(ui)

  // Each hunk opens on its line and the function git names around it.
  expect(read).toContain('Line 5 · export function retry(fn, times) { 5 } catch (error) { 6 if (i === times - 1) throw error 7 + log(error) 8 } 9 }')
  // A removed line keeps the number it had, so the line that replaces it is a number on.
  expect(read).toContain('Line 12 · export function retry(fn, times) { 12 export function delay(ms) { 13 return new Promise(resolve => {')
  expect(read).toContain('13 − setTimeout(resolve, ms) 14 + setTimeout(resolve, ms * 2) 15 }) 16 }')
  // git's file header is left to the file's row.
  expect(read).not.toContain('+++ b/src/client.js')
  await ui.unmount()
})

test('the actions on a file put it in the prompt, copy its path, and find it in the tree', async ($, on) => {
  const filled: string[] = []
  const copied: string[] = []
  engine(on)
  on('prompt.fill', (_, e) => {
    filled.push((e as { text: string }).text)

    return { isFilled: true }
  })
  on('ui.copy', (_, e) => {
    copied.push((e as { text: string }).text)

    return { value: { isCopied: true } }
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/client.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // A left press on a file's row does nothing: there is no Button on it but its ⋯.
  await ui.press({ key: 'more:tree:/proj/README.md' })
  await ui.press({ key: 'mention:tree:/proj/README.md' })
  expect(filled).toEqual(['@README.md '])
  // A done action closes the actions.
  expect(await text(ui, /^@ Mention$/)).toBeUndefined()

  await ui.press({ key: 'more:tree:/proj/README.md' })
  await ui.press({ key: 'copy:tree:/proj/README.md' })
  await ui.press({ key: 'copy-rel:tree:/proj/README.md' })
  expect(copied).toEqual(['README.md'])

  // src is closed: Show in tree opens it down to the file.
  const names = async () => ((await ui.findAll({ type: 'Text', text: /^client\.js$/ })) as unknown as unknown[]).length
  expect(await names()).toBe(1)
  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  await ui.press({ key: 'show:touched:/proj/src/client.js' })
  expect(await names()).toBe(2)
  await ui.unmount()
})

test('a diff reads as rows numbered where each line is, its shared indent taken off', () => {
  const text = ['@@ -10,4 +10,4 @@ function retry() {', '       const a = 1', '-    return a', '+    return a + 1', '\\ No newline at end of file', '     }'].join('\n')

  expect(rowsOf(text)).toEqual([
    { kind: 'hunk', line: 10, context: 'function retry() {' },
    { kind: 'same', line: 10, text: '  const a = 1' },
    { kind: 'del', line: 11, text: 'return a' },
    { kind: 'add', line: 11, text: 'return a + 1' },
    { kind: 'same', line: 12, text: '}' },
  ])
})

test('search ranks a file by its name: the letters in order, together, at a word start', () => {
  const paths = ['docs/clients/list.md', 'scripts/cli.ts', 'tests/client.test.js', 'src/client.js', 'src/connect.js']

  expect(rank(paths, 'client', 3)).toEqual(['src/client.js', 'tests/client.test.js', 'docs/clients/list.md'])
  expect(rank(paths, 'clnt', 5)).toContain('src/client.js')
  expect(rank(paths, 'zzz', 5)).toEqual([])
})

test('the touched list keeps the earlier turns, a press away', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', prompt: 'look' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/proj/README.md' })
  await $.turn.start({ turnId: 't2', prompt: 'again' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^Nothing yet$/)).toBe('Nothing yet')

  await ui.press({ key: 'scope' })
  expect(await text(ui, /^Nothing yet$/)).toBeUndefined()
  expect(await text(ui, /^README\.md$/)).toBe('README.md')
  await ui.unmount()
})

// A repository's config can make git run programs of its own on status, diff and ls-files, so
// the pane runs those in the session's repository alone: never in one it follows Claude into, nor
// one nested inside the session's.
test('git reads nothing of a repository other than the session’s', async ($, on) => {
  const ran: { argv: string[]; cwd?: string }[] = []
  const tree: Record<string, ReturnType<typeof entry>[]> = {
    '/proj': [entry('vendor', 'dir')],
    '/proj/vendor': [entry('lib.js', 'file')],
    '/work/other': [entry('util.ts', 'file')],
  }
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', () => ({ result: {} }))
  on('fs.list', (_, e) => ({ value: tree[asked((e as { path: string }).path)] ?? [] }))
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { cwd?: string } }
    const cwd = init?.cwd ?? '/proj'
    ran.push({ argv, cwd })
    // /proj/vendor is a repository of its own, inside the session's.
    const repo = cwd.startsWith('/work/other') ? '/work/other' : cwd.startsWith('/proj/vendor') ? '/proj/vendor' : '/proj'
    const stdout = argv.includes('--absolute-git-dir') ? `${repo}/.git\n` : argv.includes('--show-toplevel') ? `${repo}\n` : argv.includes('--abbrev-ref') ? 'main\n' : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: '/work/other/util.ts', old_string: 'a', new_string: 'b' })
  await settled()

  const risky = (one: { argv: string[] }) => ['status', 'diff', 'ls-files'].some(cmd => one.argv.includes(cmd))
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The tree shows the other project, with no git line: its git was never asked.
  expect(await text(ui, /^util\.ts$/)).toBe('util.ts')
  expect(await text(ui, /^main$/)).toBeUndefined()
  expect(ran.filter(one => one.cwd?.startsWith('/work/other') && risky(one))).toEqual([])
  // Every git the pane runs leaves the index lock alone.
  expect(ran.every(one => one.argv[0] !== 'git' || one.argv[1] === '--no-optional-locks')).toBe(true)
  await ui.unmount()
})

test('Show in tree works with the tree in a folder, above the project, or in another project', async ($, on) => {
  world(on, {
    '/proj': [entry('src', 'dir'), entry('home.ts', 'file')],
    '/proj/src': [entry('client.js', 'file')],
    '/': [entry('proj', 'dir'), entry('work', 'dir')],
    '/work/other': [entry('util.ts', 'file')],
  })
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/proj/src/client.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shows = async () => {
    await ui.press({ key: 'more:touched:/proj/src/client.js' })
    await ui.press({ key: 'show:touched:/proj/src/client.js' })
  }
  const inTree = async () => ((await ui.findAll({ type: 'Text', text: /^client\.js$/ })) as unknown as unknown[]).length

  // The tree inside src/, its folder's own files listed at its top.
  await ui.press({ key: 'fold:src' })
  await ui.press({ key: 'fold:src' })
  await ui.press({ key: 'up' })
  await shows()
  expect(await inTree()).toBe(2)

  // The tree in another project Claude read in: the file's own project comes back, opened to it.
  await $.tool.call({ tool: 'Read', file_path: '/work/other/util.ts' })
  expect(await text(ui, /^util\.ts$/)).toBe('util.ts')
  await shows()
  expect(await text(ui, /^home\.ts$/)).toBe('home.ts')
  expect(await inTree()).toBe(2)
  await ui.unmount()
})

test('a long touched list shows its newest files and folds the older ones a press away, on every surface', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  for (let i = 1; i <= 11; i++) await $.tool.call({ tool: 'Read', file_path: `/proj/notes/n${i}.md` })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const shown = async () => ((await ui.findAll({ type: 'Text', text: /^n\d+\.md$/ })) as unknown as unknown[]).length

    // The newest eight show; the three oldest fold into one row, the count still the whole list's.
    // The row says how many more, never "earlier": Whole session is what holds the earlier turns.
    expect(await shown()).toBe(8)
    expect(await text(ui, /^n11\.md$/)).toBe('n11.md')
    expect(await text(ui, /^n1\.md$/)).toBeUndefined()
    expect(await text(ui, /3 more$/)).toMatch(/3 more$/)
    expect(await text(ui, /Show fewer/)).toBeUndefined()
    expect(await text(ui, /earlier/i)).toBeUndefined()
    expect(await text(ui, /^ ?11 files ?$/)).toMatch(/11 files/)

    // Opened, every file shows, and the same row folds them again.
    await ui.press({ key: 'touched-all' })
    expect(await shown()).toBe(11)
    expect(await text(ui, /Show fewer$/)).toMatch(/Show fewer$/)
    expect(await text(ui, /more$/)).toBeUndefined()
    expect(await text(ui, /earlier/i)).toBeUndefined()

    await ui.press({ key: 'touched-all' })
    expect(await shown()).toBe(8)
    expect(await text(ui, /3 more$/)).toMatch(/3 more$/)
    await ui.unmount()
  }
})

test('with Whole session on, the touched list folds the earlier turns’ files with this one’s', async ($, on) => {
  engine(on)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })
  await $.turn.start({ turnId: 't1', prompt: 'look' } as never)
  for (let i = 1; i <= 6; i++) await $.tool.call({ tool: 'Read', file_path: `/proj/notes/n${i}.md` })
  await $.turn.start({ turnId: 't2', prompt: 'again' } as never)
  for (let i = 7; i <= 12; i++) await $.tool.call({ tool: 'Read', file_path: `/proj/notes/n${i}.md` })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const shown = async () => ((await ui.findAll({ type: 'Text', text: /^n\d+\.md$/ })) as unknown as unknown[]).length

  // This turn's six fit, with nothing to fold.
  expect(await shown()).toBe(6)
  expect(await text(ui, /more$/)).toBeUndefined()

  // The whole session's twelve: the newest eight, and the four before them a press away.
  await ui.press({ key: 'scope' })
  expect(await shown()).toBe(8)
  expect(await text(ui, /^n12\.md$/)).toBe('n12.md')
  expect(await text(ui, /4 more$/)).toMatch(/4 more$/)
  expect(await text(ui, /earlier/i)).toBeUndefined()
  await ui.unmount()
})
