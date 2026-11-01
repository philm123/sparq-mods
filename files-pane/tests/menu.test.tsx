import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

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

const FILE = '/proj/src/client.js'
const MORE = `more:touched:${FILE}`
const press = (action: string) => ({ key: `${action}:touched:${FILE}` })

// The host the pane runs on: its system, the editors installed (by app on a Mac, by command
// elsewhere), and whether a launch works. `ran` collects every command it is asked to run.
type Host = { system: 'Darwin' | 'Linux'; installed: string[]; isLaunchRefused?: boolean }

// The engine, as little as the ⋯ menu needs: a project at /proj with no git, and the host above.
// `copied` and `toasts` collect what the pane copied and what it told the person.
const engine = (on: Parameters<TestBody>[1], host: Host) => {
  const ran: string[][] = []
  const copied: string[] = []
  const toasts: string[] = []
  const exit = (code: number, stdout = '') => ({ value: { exitCode: code, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/proj' }))
  on('tool.call', () => ({ result: {} }))
  on('fs.list', () => ({ value: [] }))
  on('ui.copy', (_, e) => {
    copied.push((e as { text: string }).text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const { argv } = e as { argv: string[] }
    ran.push(argv)

    if (argv[0] === 'uname') return exit(0, `${host.system}\n`)
    if (argv[0] === 'open' && argv[1] === '-Ra') return exit(host.installed.includes(argv[2]!) ? 0 : 1)
    if (argv[0] === 'which') return exit(host.installed.includes(argv[1]!) ? 0 : 1)
    if (argv[0] === 'git') return exit(128)

    return exit(host.isLaunchRefused ? 1 : 0)
  })

  return { ran, copied, toasts }
}

type Ui = { findAll: (q: { type: string }) => Promise<unknown> }

// Every text the pane draws, so a label can be looked for anywhere in it.
const texts = async (ui: Ui) => ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).map(one => (one.text ?? '').trim())
const shows = async (ui: Ui, label: string) => (await texts(ui)).includes(label)

const start = async ($: Parameters<TestBody>[0], surface: 'terminal' | 'desktop' | 'vscode' | 'mobile' = 'desktop') => {
  await $.session.start({ cwd: '/proj', surface, isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: FILE })

  return $.ui.mount({ ...PANE, surface })
}

// VS Code lays no press over a menu's row, so its items are Buttons there, as on the terminal.
for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
  test(`Copy offers the absolute path, the relative path and the filename, and copies the one pressed (${surface})`, async ($, on) => {
    const { copied, toasts } = engine(on, { system: 'Darwin', installed: [] })
    const ui = await start($, surface)

    await ui.press({ key: MORE })
    expect(await shows(ui, 'Copy')).toBe(true)
    expect(await shows(ui, 'Absolute path')).toBe(false)

    await ui.press(press('copy'))
    expect(await shows(ui, 'Absolute path')).toBe(true)
    expect(await shows(ui, 'Relative path')).toBe(true)
    expect(await shows(ui, 'Filename')).toBe(true)

    await ui.press(press('copy-abs'))
    // A copy closes the menu.
    expect(await shows(ui, 'Copy')).toBe(false)

    for (const action of ['copy-rel', 'copy-name']) {
      await ui.press({ key: MORE })
      await ui.press(press('copy'))
      await ui.press(press(action))
    }

    expect(copied).toEqual(['/proj/src/client.js', 'src/client.js', 'client.js'])
    expect(toasts).toEqual(['Copied /proj/src/client.js', 'Copied src/client.js', 'Copied client.js'])
    await ui.unmount()
  })
}

test('a submenu folds on a second press, and opening one folds the other', async ($, on) => {
  engine(on, { system: 'Darwin', installed: ['Visual Studio Code'] })
  const ui = await start($)

  await ui.press({ key: MORE })
  await ui.press(press('copy'))
  expect(await shows(ui, 'Filename')).toBe(true)

  await ui.press(press('open'))
  expect(await shows(ui, 'Filename')).toBe(false)
  expect(await shows(ui, 'VS Code')).toBe(true)

  await ui.press(press('open'))
  expect(await shows(ui, 'VS Code')).toBe(false)
  expect(await shows(ui, 'Open in')).toBe(true)
  await ui.unmount()
})

test('the menu opens again with its submenus folded', async ($, on) => {
  engine(on, { system: 'Darwin', installed: [] })
  const ui = await start($)

  await ui.press({ key: MORE })
  await ui.press(press('copy'))
  await ui.press({ key: MORE })
  await ui.press({ key: MORE })

  expect(await shows(ui, 'Copy')).toBe(true)
  expect(await shows(ui, 'Filename')).toBe(false)
  await ui.unmount()
})

test('a new turn closes a menu left open, so it does not come back when Claude touches its file again', async ($, on) => {
  engine(on, { system: 'Darwin', installed: ['Visual Studio Code'] })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  const ui = await start($)

  await ui.press({ key: MORE })
  await ui.press(press('open'))
  expect(await shows(ui, 'VS Code')).toBe(true)

  await $.turn.start({ turnId: 't2', prompt: 'again' } as never)
  await $.tool.call({ tool: 'Read', file_path: FILE })

  expect(await shows(ui, 'Copy')).toBe(false)
  expect(await shows(ui, 'VS Code')).toBe(false)
  await ui.unmount()
})

test('on a Mac, Open in lists only the editors installed, and opens the file in the one pressed', async ($, on) => {
  const { ran } = engine(on, { system: 'Darwin', installed: ['Visual Studio Code', 'Cursor'] })
  const ui = await start($)

  await ui.press({ key: MORE })
  await ui.press(press('open'))
  expect(await shows(ui, 'VS Code')).toBe(true)
  expect(await shows(ui, 'Cursor')).toBe(true)
  expect(await shows(ui, 'Zed')).toBe(false)

  await ui.press(press('open-code'))
  expect(ran).toContainEqual(['open', '-a', 'Visual Studio Code', FILE])
  // A launch closes the menu.
  expect(await shows(ui, 'Open in')).toBe(false)
  await ui.unmount()
})

test('off a Mac, an editor is found by its command and opens the file with it, and there is no Finder', async ($, on) => {
  const { ran } = engine(on, { system: 'Linux', installed: ['code'] })
  const ui = await start($)

  await ui.press({ key: MORE })
  expect(await shows(ui, 'Show in Finder')).toBe(false)

  await ui.press(press('open'))
  await ui.press(press('open-code'))
  expect(ran).toContainEqual(['code', FILE])
  await ui.unmount()
})

test('with no editor installed there is no Open in, and Show in Finder selects the file in its folder', async ($, on) => {
  const { ran } = engine(on, { system: 'Darwin', installed: [] })
  const ui = await start($)

  await ui.press({ key: MORE })
  expect(await shows(ui, 'Open in')).toBe(false)

  await ui.press(press('folder'))
  expect(ran).toContainEqual(['open', '-R', FILE])
  expect(await shows(ui, 'Show in Finder')).toBe(false)
  await ui.unmount()
})

test('an editor that cannot open the file says so', async ($, on) => {
  const { toasts } = engine(on, { system: 'Darwin', installed: ['Zed'], isLaunchRefused: true })
  const ui = await start($)

  await ui.press({ key: MORE })
  await ui.press(press('open'))
  await ui.press(press('open-zed'))
  expect(toasts).toEqual(['Could not open client.js in Zed'])
  await ui.unmount()
})

test('on a phone the menu offers nothing that runs on the computer', async ($, on) => {
  engine(on, { system: 'Darwin', installed: ['Visual Studio Code'] })
  const ui = await start($, 'mobile')

  await ui.press({ key: MORE })
  expect(await shows(ui, 'Copy')).toBe(true)
  expect(await shows(ui, 'Open in')).toBe(false)
  expect(await shows(ui, 'Show in Finder')).toBe(false)
  await ui.unmount()
})
