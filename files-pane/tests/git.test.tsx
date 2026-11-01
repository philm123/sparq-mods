import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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

// A repository where HEAD names no commit a branch can be read from, answering as git does (each
// answer copied from a real run):
// - unborn: `git init`, then src/client.js written. HEAD names `main`, which has no commit yet, so
//   anything that reads HEAD's commit exits 128; `symbolic-ref` still names the branch.
// - detached: a commit checked out with `--detach`. `--abbrev-ref` prints `HEAD`, and `symbolic-ref`
//   exits 1, as HEAD names a commit, not a branch.
type Head = 'unborn' | 'detached'

const engine = (on: Parameters<TestBody>[1], head: Head, status: string[], ran: string[][] = []) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', () => ({ result: {} }))
  on('fs.list', (_, e) =>
    ((e as { path?: string }).path ?? '').endsWith('src') ? { value: [entry('client.js', 'file')] } : { value: [entry('src', 'dir')] },
  )
  on('process.run', (_, e) => {
    const { argv } = e as { argv: string[] }
    ran.push(argv)
    const answer = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const isUnborn = head === 'unborn'

    if (argv.includes('--absolute-git-dir')) return answer(0, '/proj/.git\n')
    if (argv.includes('--abbrev-ref')) return isUnborn ? answer(128, 'HEAD\n') : answer(0, 'HEAD\n\n')
    if (argv.includes('--show-prefix')) return answer(0, '\n')
    if (argv.includes('symbolic-ref')) return isUnborn ? answer(0, 'main\n') : answer(1)
    if (argv.includes('rev-parse') && argv.includes('HEAD')) return isUnborn ? answer(128, 'HEAD\n') : answer(0, '9f3b210\n')
    if (argv.includes('status')) return answer(0, status.map(line => `${line}\0`).join(''))
    if (argv.includes('rev-list')) return answer(128)
    if (argv.includes('ls-files') && argv.includes('--error-unmatch')) return answer(status.some(one => one.startsWith('A ')) ? 0 : 1)
    if (argv.includes('diff') && argv.includes('HEAD')) return isUnborn ? answer(128) : answer(0)
    if (argv.includes('diff') && argv.includes('--no-index'))
      return answer(1, 'diff --git a/src/client.js b/src/client.js\nnew file mode 100644\n--- /dev/null\n+++ b/src/client.js\n@@ -0,0 +1,2 @@\n+export const retry = 3\n+export const delay = 100\n')

    return answer(0)
  })
}

const text = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<{ text?: string } | undefined> }, pattern: RegExp) =>
  (await ui.find({ type: 'Text', text: pattern }))?.text

// The pane reads git as a session starts only once a module's life, so each test asks it again, as
// a press on ↻ Refresh does.
const mounted = async ($: Parameters<TestBody>[0]) => {
  await $.session.start({ cwd: '/proj', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'refresh' })

  return ui
}

test('a repository with no commit yet still shows its branch and what is changed', async ($, on) => {
  engine(on, 'unborn', ['?? src/client.js'])

  const ui = await mounted($)

  expect(await text(ui, /^main$/)).toBe('main')
  expect(await text(ui, /1 changed/)).toMatch(/1 changed/)
  expect(await text(ui, /Not committed/)).toMatch(/Not committed/)
  await ui.unmount()
})

test('a detached HEAD shows the commit checked out, not the word HEAD', async ($, on) => {
  engine(on, 'detached', [])

  const ui = await mounted($)

  expect(await text(ui, /^9f3b210$/)).toBe('9f3b210')
  expect(await text(ui, /^HEAD$/)).toBeUndefined()
  expect(await text(ui, /clean, nothing changed/)).toBe('clean, nothing changed')
  await ui.unmount()
})

// Staged with `git add`, the file is tracked, but there is no HEAD to diff it against: all of it is new.
test('with no commit yet, a staged file’s Diff shows the whole file as added', async ($, on) => {
  const ran: string[][] = []
  engine(on, 'unborn', ['A  src/client.js'], ran)

  const ui = await mounted($)

  await $.tool.call({ tool: 'Edit', file_path: '/proj/src/client.js', old_string: 'a', new_string: 'b' })

  await ui.press({ key: 'more:touched:/proj/src/client.js' })
  await ui.press({ key: 'diff:touched:/proj/src/client.js' })
  expect(await text(ui, /No changes since the last commit/)).toBeUndefined()
  expect(await text(ui, /export const retry = 3/)).toMatch(/export const retry = 3/)
  // The Diff (`-U2`) never asks git for a HEAD there is not.
  expect(ran.some(argv => argv.includes('-U2') && argv.includes('HEAD'))).toBe(false)
  await ui.unmount()
})
