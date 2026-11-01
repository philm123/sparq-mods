import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

// The pane on Windows: the session's folder and Claude's files come as `C:\proj\…`, git prints
// `C:/proj`, and the pane holds one spelling of each, so a file in the project is the project's.

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

const entry = (name: string, kind: 'file' | 'dir') => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })

// The path the pane listed or read, as it asked for it. The test engine resolves a path against the
// system it runs on: off Windows `C:/proj` is relative, and comes after the folder the tests run in.
const asked = (path: string) => path.replace(/^.*?(?=[A-Za-z]:[\\/])/, '').replace(/\\/g, '/')

// The folders the pane may list, by the spelling it asks for them in.
const TREE: Record<string, ReturnType<typeof entry>[]> = {
  'C:/proj': [entry('src', 'dir'), entry('home.ts', 'file')],
  'C:/proj/src': [entry('client.js', 'file')],
  'D:/work/other': [entry('lib', 'dir')],
  'D:/work/other/lib': [entry('util.ts', 'file')],
}

// Where the editors are on the PATH, as `where` lists them (one a line, CRLF), by command; and the
// files on the disk the pane may read, by path, as the editors' installers leave them.
// `isPowerShellMissing` makes PowerShell fail to start.
type Installed = { where?: Record<string, string>; files?: Record<string, string>; isPowerShellMissing?: boolean }

// The engine on a Windows host: the session in C:\proj, a repository on branch main with
// src/client.js changed, and another at D:\work\other, and the editors `installed`. Explorer exits
// 1, as it does when it opens a folder. A commit moves HEAD to a1c9e42. `ran` collects every command
// with the folder it runs in and the variables it sets; `listed` every folder listed; `copied` and
// `toasts` what the pane copied and told the person.
const engine = (on: Parameters<TestBody>[1], installed: Installed = {}) => {
  const ran: { argv: string[]; cwd?: string; env?: Record<string, string> }[] = []
  const listed: string[] = []
  const copied: string[] = []
  const toasts: string[] = []
  let head = '9f3b210'

  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: 'C:\\proj' }))
  on('tool.call', (_, e) => {
    if (/\bcommit\b/.test((e as { command?: string }).command ?? '')) head = 'a1c9e42'

    return { result: {} }
  })
  on('fs.list', (_, e) => {
    const path = asked((e as { path: string }).path)
    listed.push(path)

    return { value: TREE[path] ?? [] }
  })
  on('fs.read', (_, e) => {
    const text = installed.files?.[asked((e as { path: string }).path)]

    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('ui.copy', (_, e) => {
    copied.push((e as { text: string }).text)

    return { value: { isCopied: true } }
  })
  on('ui.toast', (_, e) => {
    toasts.push((e as { text: string }).text)

    return { value: undefined }
  })
  on('process.run', (_, e) => {
    const { argv, init } = e as { argv: string[]; init?: { cwd?: string; env?: Record<string, string> } }
    const cwd = init?.cwd ?? 'C:\\proj'
    ran.push({ argv, cwd: init?.cwd, env: init?.env })

    if (argv[0] === 'powershell' && installed.isPowerShellMissing) throw new Error('ENOENT')

    if (argv[0] === 'where') {
      const found = installed.where?.[argv[1]!.replace(/^\$PATH:/, '')]

      return { value: { exitCode: found ? 0 : 1, stdout: found ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }

    const repo = cwd.startsWith('D:/work/other') ? 'D:/work/other' : 'C:/proj'
    const stdout = argv.includes('--absolute-git-dir')
      ? `${repo}/.git\n`
      : argv.includes('--show-toplevel')
        ? `${repo}\n`
        : argv.includes('--abbrev-ref')
          ? 'main\n'
          : argv.includes('--short')
            ? `${head}\n`
          : argv.includes('status')
            ? ' M src/client.js\0'
            : argv.includes('rev-list')
              ? '0\n'
              : ''

    return { value: { exitCode: argv[0] === 'explorer' ? 1 : 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  return { ran, listed, copied, toasts }
}

// The script a PowerShell run was handed as `-EncodedCommand`: UTF-16LE in base64.
const scriptOf = (argv: string[]) => atob(argv[argv.indexOf('-EncodedCommand') + 1] ?? '').replace(/\0/g, '')

// What Show in Explorer ran: the path PowerShell was handed, and the script it ran.
const revealed = (ran: { argv: string[]; env?: Record<string, string> }[]) =>
  ran.filter(one => one.argv[0] === 'powershell').map(one => ({ path: one.env?.FILES_PANE_PATH, script: scriptOf(one.argv) }))

// Lets what the pane started without waiting (a read of git) run to its end.
const settled = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const text = async (ui: { find: (q: { type: string; text: RegExp }) => Promise<{ text?: string } | undefined> }, pattern: RegExp) =>
  (await ui.find({ type: 'Text', text: pattern }))?.text

type Ui = { findAll: (q: { type: string }) => Promise<unknown> }

const shows = async (ui: Ui, label: string) =>
  ((await ui.findAll({ type: 'Text' })) as { text?: string }[]).some(one => (one.text ?? '').trim() === label)

test('on Windows, a file Claude edits in the project is the project’s, and git reads the project', async ($, on) => {
  const { ran, listed } = engine(on)
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: 'C:\\proj\\src\\client.js', old_string: 'a', new_string: 'b' })
  await $.turn.complete({ turnId: 't1', answer: 'done', durationMs: 10, isAborted: false } as never)
  await settled()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // The touched list names its folder from the project, and the tree stays home, opened down to it.
  expect(await text(ui, /^client\.js$/)).toBe('client.js')
  expect(await text(ui, /^src$/)).toBe('src')
  expect(await text(ui, /:\//)).toBeUndefined()
  expect(await text(ui, /^home\.ts$/)).toBe('home.ts')
  expect(listed).toContain('C:/proj/src')
  // Git is the session's own, so it runs: the branch shows.
  expect(await text(ui, /^main$/)).toBe('main')
  expect(ran.some(one => one.argv.includes('status'))).toBe(true)
  await ui.unmount()
})

test('on Windows, the tree follows Claude to a project on another drive, without its git, and back', async ($, on) => {
  const { ran } = engine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Edit', file_path: 'd:\\work\\other\\lib\\util.ts', old_string: 'a', new_string: 'b' })
  await settled()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  expect(await text(ui, /^lib$/)).toBe('lib')
  expect(await text(ui, /^util\.ts$/)).toBe('util.ts')
  expect(await text(ui, /^home\.ts$/)).toBeUndefined()
  // Another repository's config may run programs: nothing but rev-parse runs there.
  const risky = (one: { argv: string[] }) => ['status', 'diff', 'ls-files'].some(cmd => one.argv.includes(cmd))
  expect(ran.filter(one => one.cwd?.startsWith('D:') && risky(one))).toEqual([])

  await ui.press({ key: 'home' })
  expect(await text(ui, /^home\.ts$/)).toBe('home.ts')
  await ui.unmount()
})

test('on Windows, a file outside the project shows its folder from ~', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\Users\\someone\\notes\\plan.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await text(ui, /^~\/notes$/)).toBe('~/notes')
  await ui.unmount()
})

test('on Windows, a commit made from Git Bash with -C /c/… marks the project’s files committed', async ($, on) => {
  const { ran } = engine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git -C /c/proj commit -m "fix"' })

  expect(ran.some(one => one.argv.includes('show') && one.cwd === 'C:/proj')).toBe(true)
})

test('on Windows, the ⋯ copies paths with \\, shows the file in Explorer, and has no Open in with no editor on the PATH', async ($, on) => {
  const { ran, copied, toasts } = engine(on)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\src\\client.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const FILE = 'C:/proj/src/client.js'
  const press = (action: string) => ({ key: `${action}:touched:${FILE}` })

  for (const action of ['copy-abs', 'copy-rel']) {
    await ui.press(press('more'))
    await ui.press(press('copy'))
    await ui.press(press(action))
  }
  expect(copied).toEqual(['C:\\proj\\src\\client.js', 'src\\client.js'])

  await ui.press(press('more'))
  expect(await shows(ui, 'Open in')).toBe(false)
  expect(await shows(ui, 'Show in Finder')).toBe(false)
  await ui.press(press('folder'))
  // PowerShell starts Explorer on the file and brings its window forward. The path comes in a
  // variable, so no file name can change the script.
  const [reveal] = revealed(ran)
  expect(reveal?.path).toBe('C:\\proj\\src\\client.js')
  expect(reveal?.script).toContain("Start-Process explorer.exe -ArgumentList '/select,'")
  expect(reveal?.script).toContain('SetForegroundWindow')
  expect(reveal?.script).not.toContain('client.js')
  // Explorer's exit 1 is no failure.
  expect(toasts.filter(one => one.startsWith('Could not'))).toEqual([])
  // Windows is known from the session's folder: no uname, no which. Editors are looked for on the
  // PATH only, never in the project.
  expect(ran.some(one => one.argv[0] === 'uname' || one.argv[0] === 'which')).toBe(false)
  expect(ran.filter(one => one.argv[0] === 'where').map(one => one.argv[1])).toContain('$PATH:code')
  expect(ran.every(one => one.argv[0] !== 'where' || one.argv[1]!.startsWith('$PATH:'))).toBe(true)
  await ui.unmount()
})

test('on Windows, Show in Explorer hands a path with a space whole, and Explorer alone where PowerShell cannot start', async ($, on) => {
  const { ran, toasts } = engine(on, { isPowerShellMissing: true })
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\my notes\\plan.md' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const FILE = 'C:/proj/my notes/plan.md'

  await ui.press({ key: `more:touched:${FILE}` })
  await ui.press({ key: `folder:touched:${FILE}` })
  expect(revealed(ran).map(one => one.path)).toEqual(['C:\\proj\\my notes\\plan.md'])
  // As one argument, `"/select,C:\proj\my notes\plan.md"`, Explorer would open Documents instead.
  expect(ran.map(one => one.argv)).toContainEqual(['explorer', '/select,', 'C:\\proj\\my notes\\plan.md'])
  expect(toasts.filter(one => one.startsWith('Could not'))).toEqual([])
  await ui.unmount()
})

// Editors as their installers leave them on Windows. VS Code's `bin` holds `code` for Git Bash and
// `code.cmd`, which runs the app's own program as Node on the script that opens the app, in a folder
// named for the build; another editor's script may sit further from its program. Zed's command is a program. A JetBrains
// Toolbox script starts the IDE itself, which a launch would wait on.
const VS_CODE = 'C:\\Users\\someone\\AppData\\Local\\Programs\\Microsoft VS Code'
const CURSOR = 'C:\\Users\\someone\\AppData\\Local\\Programs\\cursor'
const ZED = 'C:\\Users\\someone\\AppData\\Local\\Programs\\Zed\\bin\\zed.exe'
const TOOLBOX = 'C:\\Users\\someone\\AppData\\Local\\JetBrains\\Toolbox\\scripts\\idea.cmd'

const shim = (exe: string, cli: string) =>
  ['@echo off', 'setlocal', 'set VSCODE_DEV=', 'set ELECTRON_RUN_AS_NODE=1', `"%~dp0${exe}" "%~dp0${cli}" %*`, 'IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%', 'endlocal', ''].join('\r\n')

const INSTALLED: Installed = {
  where: {
    code: `${VS_CODE}\\bin\\code\r\n${VS_CODE}\\bin\\code.cmd\r\n`,
    cursor: `${CURSOR}\\resources\\app\\bin\\cursor\r\n${CURSOR}\\resources\\app\\bin\\cursor.cmd\r\n`,
    zed: `${ZED}\r\n`,
    idea: `${TOOLBOX}\r\n`,
  },
  files: {
    [`${VS_CODE}\\bin\\code.cmd`.replace(/\\/g, '/')]: shim('..\\Code.exe', '..\\2c33b50b16\\resources\\app\\out\\cli.js'),
    [`${CURSOR}\\resources\\app\\bin\\cursor.cmd`.replace(/\\/g, '/')]: shim('..\\..\\..\\Cursor.exe', '..\\out\\cli.js'),
    [TOOLBOX.replace(/\\/g, '/')]: '@echo off\r\nstart "" "C:\\Program Files\\JetBrains\\IntelliJ IDEA\\bin\\idea64.exe" %*\r\n',
  },
}

// Opens the ⋯ of `file` (as the pane spells it), then its Open in.
const openIn = async (ui: { press: (key: { key: string }) => Promise<unknown> }, file: string) => {
  const press = (action: string) => ({ key: `${action}:touched:${file}` })
  await ui.press(press('more'))
  await ui.press(press('open'))

  return press
}

test('on Windows, Open in lists the editors on the PATH it can start, and starts each with no shell', async ($, on) => {
  const { ran, toasts } = engine(on, INSTALLED)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\src\\client.js' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const press = await openIn(ui, 'C:/proj/src/client.js')

  expect(await shows(ui, 'VS Code')).toBe(true)
  expect(await shows(ui, 'Cursor')).toBe(true)
  expect(await shows(ui, 'Zed')).toBe(true)
  // Toolbox's script is no VS Code one, and Sublime Text is not on the PATH.
  expect(await shows(ui, 'IntelliJ IDEA')).toBe(false)
  expect(await shows(ui, 'Sublime Text')).toBe(false)

  // VS Code runs as its code.cmd runs it: its program as Node, on the script that opens the app.
  await ui.press(press('open-code'))
  expect(ran).toContainEqual({
    argv: [`${VS_CODE}\\Code.exe`, `${VS_CODE}\\2c33b50b16\\resources\\app\\out\\cli.js`, 'C:\\proj\\src\\client.js'],
    cwd: undefined,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })

  // Zed's command is a program, so it runs as it is.
  await openIn(ui, 'C:/proj/src/client.js')
  await ui.press(press('open-zed'))
  expect(ran).toContainEqual({ argv: [ZED, 'C:\\proj\\src\\client.js'], cwd: undefined, env: undefined })
  expect(toasts.filter(one => one.startsWith('Could not'))).toEqual([])
  // Nothing goes through cmd.
  expect(ran.some(one => /^cmd(?:\.exe)?$/i.test(one.argv[0]!) || /\.cmd$/i.test(one.argv[0]!))).toBe(false)
  await ui.unmount()
})

test('on Windows, a file named with spaces, &, ^ and % reaches the editor whole, as one argument', async ($, on) => {
  const { ran } = engine(on, INSTALLED)
  await $.session.start({ cwd: 'C:\\proj', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: 'C:\\proj\\100% done & a^b.ts' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const press = await openIn(ui, 'C:/proj/100% done & a^b.ts')

  await ui.press(press('open-cursor'))
  expect(ran).toContainEqual({
    argv: [`${CURSOR}\\Cursor.exe`, `${CURSOR}\\resources\\app\\out\\cli.js`, 'C:\\proj\\100% done & a^b.ts'],
    cwd: undefined,
    env: { ELECTRON_RUN_AS_NODE: '1' },
  })
  await ui.unmount()
})
