import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { DIRTY, DONE, EDIT, READ } from '../hooks/look'

const PANE = {
  plugin: 'files-pane',
  component: 'Pane',
  requestId: 'files-pane',
  props: {
    title: 'Files: proj',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 120 },
    view: {},
  },
} as const

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })

// What `git status --porcelain -z -uall` printed for a real repository put in each state: mid-merge
// with a conflict, a rename (its old path next), staged and unstaged changes, an untracked file, a
// file added with `git add -N`.
const STATUS = [
  'A  added.txt',
  'AM addmod.txt',
  ' A intent.txt',
  'MM both.txt',
  'UU conflict.txt',
  ' D del.txt',
  ' M mod.txt',
  'R  renamed.txt',
  'ren.txt',
  'D  sdel.txt',
  'M  staged.txt',
  '?? untracked.txt',
]

// On disk: every file git names but the two deleted, a clean one Claude reads, a clean one nobody
// touches, a file Claude commits, and an ignored folder.
const FILES = ['added.txt', 'addmod.txt', 'intent.txt', 'both.txt', 'conflict.txt', 'mod.txt', 'renamed.txt', 'staged.txt', 'untracked.txt']
const ON_DISK = [...FILES, 'read.txt', 'clean.txt', 'shipped.txt']

const engine = (on: Parameters<TestBody>[1], world: { status: string[]; head: string }) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', (_, e) => {
    // A commit takes shipped.txt out of what git reports as changed.
    if (/\bcommit\b/.test((e as { command?: string }).command ?? '')) {
      world.head = 'a1c9e42'
      world.status = world.status.filter(one => !one.endsWith('shipped.txt'))
    }

    return { result: {} }
  })
  on('fs.list', () => ({ value: [entry('ignored', 'dir'), ...ON_DISK.map(name => entry(name, 'file'))] }))
  on('process.run', (_, e) => {
    const { argv } = e as { argv: string[] }
    const stdout = argv.includes('--abbrev-ref')
      ? 'main\n\n'
      : argv.includes('--absolute-git-dir')
        ? '/proj/.git\n'
        : argv.includes('--short') && argv.includes('rev-parse')
          ? `${world.head}\n`
          : argv.includes('status')
            ? world.status.map(line => `${line}\0`).join('')
            : argv.includes('ls-files')
              ? 'ignored/\0'
              : argv.includes('rev-list')
                ? '0\n'
                : argv.includes('show')
                  ? 'shipped.txt\n'
                  : ''

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const settled = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

type Drawn = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

// Every Text a row draws, as [text, color, dimmed], in order.
const textsOf = (node: unknown): [string, unknown, unknown][] => {
  if (!node || typeof node !== 'object') return []

  const { type, props = {}, children = [] } = node as Drawn
  const own = type === 'Text' ? [[children.filter(one => typeof one === 'string').join(''), props.color, props.dimColor] as [string, unknown, unknown]] : []

  return [...own, ...children.flatMap(textsOf)]
}

type Ui = { findAll: (q: { type?: string; key?: string }) => Promise<unknown> }

// A row by its key: its name's color, whether the name is dimmed, and git's letter (a lone capital).
const rowOf = async (ui: Ui, key: string, name: string) => {
  const [row] = (await ui.findAll({ type: 'Box', key })) as unknown[]
  const texts = textsOf(row)
  const label = texts.find(([text]) => text === name)

  return {
    color: label?.[1],
    isDim: Boolean(label?.[2]),
    mark: texts.find(([text]) => /^[MADRUC]$/.test(text))?.[0],
  }
}

for (const surface of ['terminal', 'desktop'] as const) {
  // Each color says what Claude did (purple read, orange edited, green committed) or that git has the
  // file changed (yellow); the letter says what git sees, whoever has the file.
  test(`every file state draws its color and git's letter (${surface})`, async ($, on) => {
    const world = { status: [...STATUS, ' M shipped.txt'], head: '9f3b210' }
    engine(on, world)
    await $.session.start({ cwd: '/proj', surface, isInteractive: true })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/shipped.txt', old_string: 'a', new_string: 'b' })
    await $.tool.call({ tool: 'Bash', command: 'git commit -am ship' })
    await $.tool.call({ tool: 'Read', file_path: '/proj/read.txt' })
    await $.tool.call({ tool: 'Read', file_path: '/proj/del.txt' })
    await $.tool.call({ tool: 'Edit', file_path: '/proj/mod.txt', old_string: 'a', new_string: 'b' })

    const ui = await $.ui.mount({ ...PANE, surface })
    await settled()

    const tree = async (name: string) => rowOf(ui, `row:${name}`, name)
    const touched = async (name: string) => rowOf(ui, `touch:${name}`, name)

    // Untouched by Claude: yellow with git's letter, a rename's old path not a file of its own.
    expect(await tree('added.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'A' })
    expect(await tree('addmod.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'A' })
    expect(await tree('intent.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'A' })
    expect(await tree('both.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'M' })
    expect(await tree('conflict.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'C' })
    expect(await tree('renamed.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'R' })
    expect(await tree('staged.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'M' })
    expect(await tree('untracked.txt')).toEqual({ color: DIRTY, isDim: false, mark: 'U' })
    expect(await ui.findAll({ type: 'Box', key: 'row:ren.txt' })).toHaveLength(0)

    // Clean and ignored: no color, no letter; ignored dimmed.
    expect(await tree('clean.txt')).toEqual({ color: undefined, isDim: false, mark: undefined })
    expect(await tree('ignored')).toEqual({ color: undefined, isDim: true, mark: undefined })

    // Claude's: the color is Claude's, the letter git's.
    for (const at of [tree, touched]) {
      expect(await at('read.txt')).toEqual({ color: READ, isDim: false, mark: undefined })
      expect(await at('mod.txt')).toEqual({ color: EDIT, isDim: false, mark: 'M' })
      expect(await at('shipped.txt')).toEqual({ color: DONE, isDim: false, mark: undefined })
    }

    // A file deleted from disk is in no tree, but the touched list still letters it.
    expect(await touched('del.txt')).toEqual({ color: READ, isDim: false, mark: 'D' })
    await ui.unmount()
  })
}
