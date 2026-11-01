import type { EngineInterface } from 'claude-code'

import { sessionDir } from './disk'
import { backslashed, isWindowsPath } from './paths'

// The apps a file's ⋯ can open it in, the editors installed on the host, found once a session.
// On macOS an editor is its app, which need not have put its command on the PATH (VS Code's
// `code` waits for a step most never take); on Linux it is its command. On Windows it is what its
// command starts (see `launchOf`).

// How Windows starts an editor: the program and what goes before the file, and the variables set.
export type Launch = { argv: string[]; env?: Record<string, string> }

export type Editor = { name: string; app: string; cli: string; launch?: Launch }

const EDITORS: Editor[] = [
  { name: 'VS Code', app: 'Visual Studio Code', cli: 'code' },
  { name: 'Cursor', app: 'Cursor', cli: 'cursor' },
  { name: 'Windsurf', app: 'Windsurf', cli: 'windsurf' },
  { name: 'Zed', app: 'Zed', cli: 'zed' },
  { name: 'Sublime Text', app: 'Sublime Text', cli: 'subl' },
  { name: 'WebStorm', app: 'WebStorm', cli: 'webstorm' },
  { name: 'IntelliJ IDEA', app: 'IntelliJ IDEA', cli: 'idea' },
  { name: 'Xcode', app: 'Xcode', cli: 'xed' },
]

// Which system the host is, told by the session's folder on Windows (`C:\…`), else by `uname`.
export type Host = { system: 'mac' | 'windows' | 'other'; editors: Editor[] }

// Kept for the module's life: a reload looks again, so an editor installed since shows up then.
let found: Promise<Host> | null = null

function succeeds($: EngineInterface, argv: string[], init: { env?: Record<string, string>; timeoutMs?: number } = {}) {
  return $.process
    .run(argv, { timeoutMs: 5000, ...init })
    .then(out => out.exitCode === 0)
    .catch(() => false)
}

// A Windows path with each `..` taken as the folder above: `C:\VS Code\bin\..\Code.exe` is
// `C:\VS Code\Code.exe`.
const climbed = (path: string) =>
  path
    .split('\\')
    .reduce<string[]>((parts, part) => (part === '..' && parts.length > 1 ? parts.slice(0, -1) : [...parts, part]), [])
    .join('\\')

// The line a VS Code-built editor's `bin\code.cmd` (Cursor's and Windsurf's alike) runs: its own
// program as Node (ELECTRON_RUN_AS_NODE), on the script that opens the app and returns. `%~dp0` is
// the script's folder.
const SHIM = /^"%~dp0([^"%]+\.exe)" "%~dp0([^"%]+\.js)" %\*$/m

// How Windows starts an editor, from what its command is on the PATH, or null when it cannot:
// - an `.exe` (Zed's `zed`, Sublime's `subl`) starts the app and returns, so it runs as it is;
// - a `.cmd` cannot run without a shell, and `cmd /c` would read `%`, `&` and `^` in a file's name
//   as its own. So the editor runs as the script would run it, with no shell, when the script is
//   VS Code's; any other script's editor is not offered.
// `$PATH:` keeps `where` to the PATH: on its own it looks first in the project, whose files are no
// program to run.
async function launchOf($: EngineInterface, cli: string): Promise<Launch | null> {
  const out = await $.process.run(['where', `$PATH:${cli}`], { timeoutMs: 5000 }).catch(() => null)
  // Every match, one a line: VS Code's `bin` has an `.exe`-less `code` for Git Bash beside `code.cmd`.
  const path = out?.exitCode === 0 ? out.stdout.split(/\r?\n/).find(line => /\.(?:exe|cmd)$/i.test(line.trim()))?.trim() : undefined

  if (!path) return null
  if (/\.exe$/i.test(path)) return { argv: [path] }

  const script = (await $.fs.read(path).catch(() => '')).replace(/\r\n/g, '\n')
  const line = SHIM.exec(script)

  if (!line || !/^set ELECTRON_RUN_AS_NODE=1$/m.test(script)) return null

  const dir = path.slice(0, path.lastIndexOf('\\') + 1)

  return { argv: [climbed(dir + line[1]), climbed(dir + line[2])], env: { ELECTRON_RUN_AS_NODE: '1' } }
}

// `open -Ra` asks Launch Services whether the app is there, and opens nothing.
export function hostOf($: EngineInterface): Promise<Host> {
  found ??= (async () => {
    if (isWindowsPath(await sessionDir($).catch(() => ''))) {
      const launches = await Promise.all(EDITORS.map(one => launchOf($, one.cli)))

      return { system: 'windows' as const, editors: EDITORS.flatMap((one, i) => (launches[i] ? [{ ...one, launch: launches[i] }] : [])) }
    }

    const out = await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).catch(() => null)
    const isMac = out?.stdout.trim() === 'Darwin'
    const has = await Promise.all(
      EDITORS.map(one => succeeds($, isMac ? ['open', '-Ra', one.app] : ['which', one.cli])),
    )

    return { system: isMac ? ('mac' as const) : ('other' as const), editors: EDITORS.filter((_, i) => has[i]) }
  })()

  return found
}

// The file in `editor`, on the host: by its app on macOS, as its command would start it on Windows
// (the file with `\`, and time for a cold start of the program as Node), by its command elsewhere.
export function openIn($: EngineInterface, host: Host, editor: Editor, abs: string) {
  if (host.system === 'windows' && editor.launch) {
    return succeeds($, [...editor.launch.argv, backslashed(abs)], { env: editor.launch.env, timeoutMs: 15000 })
  }

  return succeeds($, host.system === 'mac' ? ['open', '-a', editor.app, abs] : [editor.cli, abs])
}

// The app that shows a file in its folder on the host, by name: none on Linux, which has no one
// file manager to ask.
export const folderApp = (host: Host) => (host.system === 'mac' ? 'Finder' : host.system === 'windows' ? 'Explorer' : null)

// Explorer started by the pane opens behind the app the person is in: Windows keeps a background
// process from bringing a window forward. So PowerShell starts Explorer, finds its new window among
// the shell's by its folder, and brings that window forward. The path comes in FILES_PANE_PATH,
// never in the script, and is made whole first: Explorer opens the wrong folder for a path with
// `..`. `/select,` and the path go as two arguments: a path with a space is quoted on Explorer's
// command line, and Explorer reads `"/select,C:\a b\f"`, quoted whole, as no switch.
const REVEAL = `
$path = [IO.Path]::GetFullPath($env:FILES_PANE_PATH)
$folder = [IO.Path]::GetDirectoryName($path)
$shell = New-Object -ComObject Shell.Application
$inFolder = { @($shell.Windows() | Where-Object { try { $_.Document.Folder.Self.Path -eq $folder } catch { $false } }) }
$before = @(& $inFolder | ForEach-Object { $_.HWND })
Start-Process explorer.exe -ArgumentList '/select,', ('"' + $path + '"')
Add-Type -Namespace FilesPane -Name Window -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
for ($i = 0; $i -lt 30; $i++) {
  $all = & $inFolder
  $new = @($all | Where-Object { $before -notcontains $_.HWND })
  $window = if ($new.Count -gt 0) { $new[-1] } elseif ($i -ge 20 -and $all.Count -gt 0) { $all[-1] } else { $null }
  if ($window) { [void][FilesPane.Window]::SetForegroundWindow([IntPtr]$window.HWND); break }
  Start-Sleep -Milliseconds 100
}
`

// A script as PowerShell's `-EncodedCommand` takes it, UTF-16LE in base64, so no quoting on the
// command line can change it. REVEAL is ASCII: each character is its byte, then a zero.
export const encoded = (script: string) => btoa([...script].map(char => `${char}\0`).join(''))

// The file selected in a window of its folder: Finder's, or Explorer's, in front. Explorer takes
// the path only with `\`. A host where PowerShell cannot start gets Explorer alone, which exits 1
// whether or not it opened one: either counts as done once it starts.
export function showInFolder($: EngineInterface, host: Host, abs: string) {
  if (host.system === 'windows') {
    const path = backslashed(abs)

    return $.process
      .run(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(REVEAL)], { timeoutMs: 15000, env: { FILES_PANE_PATH: path } })
      .catch(() => $.process.run(['explorer', '/select,', path], { timeoutMs: 5000 }))
      .then(() => true)
      .catch(() => false)
  }

  return succeeds($, ['open', '-R', abs])
}
