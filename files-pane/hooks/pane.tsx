import { atom, read, update } from 'claude-code'
import type { EngineInterface, RenderInput, Space } from 'claude-code'

import type { Menu, Touch, View } from '../types'
import { absOf, cardSince, follow, reveal, toggleDiff } from './activity'
import { rowsOf } from './diff'
import { forget, indexFiles, listDir, redraw, refreshGit, sessionDir, SKIP } from './disk'
import { folderApp, hostOf, openIn, showInFolder } from './editors'
import { fileIcon, folderIcon } from './icons'
import {
  ADDED,
  badgeSvg,
  BLANK_SVG,
  BRANCH_SVG,
  CARD,
  CARD_EDGE,
  CARETS,
  chevronSvg,
  CLEAR,
  DIRTY,
  DONE,
  dotSvg,
  EDIT,
  FOLDER,
  glyphOf,
  HOVER,
  kindOf,
  MUTED,
  READ,
  REMOVED,
  RULE_SVG,
  shimmerSvg,
  TEXT_GLYPH,
  tint,
  TOOL,
  WRITE,
} from './look'
import { backslashed, base, closedAbove, dirOf, isUnder, isWindowsPath, join, listPath, parentOf, plural, rank, rel, sizeOf, timeOf, where } from './paths'
import { DEFAULT_VIEW, PANE } from './state'

// The values this file reads or writes. The engine's scan wants each made by `atom` in the file that
// uses it, so every file names its own; state.ts lists the tags they must all share.
const diff = atom({ plugin: 'files-pane', key: 'diff' } as const, null, { shape: 'diff-2' })
const earlier = atom({ plugin: 'files-pane', key: 'earlier' } as const, [], { shape: 'touched-3' })
const git = atom({ plugin: 'files-pane', key: 'git' } as const, null, { shape: 'git-4' })
const menu = atom({ plugin: 'files-pane', key: 'menu' } as const, null, { shape: 'menu-2' })
const now = atom({ plugin: 'files-pane', key: 'now' } as const, null, { shape: 'now-3' })
const scope = atom({ plugin: 'files-pane', key: 'scope' } as const, 'turn', { shape: 'scope-1' })
const isTouchedAll = atom({ plugin: 'files-pane', key: 'isTouchedAll' } as const, false)
const status = atom({ plugin: 'files-pane', key: 'status' } as const, null, { shape: 'status-1' })
const tick = atom({ plugin: 'files-pane', key: 'tick' } as const, 0)
const touched = atom({ plugin: 'files-pane', key: 'touched' } as const, [], { shape: 'touched-3' })
const view = atom({ plugin: 'files-pane', key: 'view' } as const, DEFAULT_VIEW, { shape: 'view-3' })

const TREE_ROWS = 300
const MATCHES = 50
// The touched list shows its newest files up to this many, and offers the rest a press away.
const TOUCHED_ROWS = 8

// The surfaces whose pane held the keyboard while a file's menu was open. A click away from the
// pane (into the chat, the prompt) takes the keyboard from it, and that closes the menu, as a
// click away does a native menu's. Each surface by its own: a phone that never focuses the pane
// closes nothing on the desktop.
const focusedWithMenu = new Set<string>()

// The pane: the card saying what Claude is doing, git's line, search, the toolbar, the files Claude
// touched and the project's tree, each file with its actions behind a ⋯. Drawn by register.tsx's
// `ui.render` hook for the pane.
export async function renderPane($: EngineInterface, e: RenderInput<'Pane'>) {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    // Search needs a text field and the icons an SVG, which not every surface draws.
    const Input = 'Input' in elements ? elements.Input : null
    // The terminal's table answers `in` for Svg too, but draws none: ask the surface.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : null
    // A drawing writes no state: the menu closes right after, from a timer.
    if (e.props.isFocused) {
      if (await read($, menu)) focusedWithMenu.add(e.surface)
      else focusedWithMenu.delete(e.surface)
    } else if (focusedWithMenu.delete(e.surface)) {
      $.clock.after(0, async () => {
        await update($, menu, () => null)
        await update($, diff, () => null)
        redraw($)
      })
    }
    const [cur, list, prior, sc, isAll, v, g, open, acts, foot] = await Promise.all([
      read($, now),
      read($, touched),
      read($, earlier),
      read($, scope),
      read($, isTouchedAll),
      read($, view),
      read($, git),
      read($, diff),
      read($, menu),
      read($, status),
    ])
    await read($, tick)
    const cwd = await sessionDir($)
    // The editors a file's ⋯ offers, looked for once, as the session starts.
    const host = acts ? await hostOf($) : null
    // The project the tree shows: the session's folder, or the one it followed Claude to.
    const home = v.root || cwd
    const project = base(home)
    const changed = new Set(g?.changed ?? [])
    // A touched file as the tree spells it, relative to the project shown; null outside it.
    const keyOf = (path: string) => {
      const abs = absOf(cwd, path)

      return abs.startsWith(`${home}/`) ? abs.slice(home.length + 1) : null
    }
    const byPath = new Map(list.flatMap(one => (keyOf(one.path) === null ? [] : [[keyOf(one.path)!, one] as const])))
    const setView = async (patch: Partial<View>) => {
      await update($, view, old => ({ ...old, ...patch }))
      redraw($)
      if (patch.root !== undefined && patch.root !== v.root) {
        forget()
        void refreshGit($)
      }
    }

    // From the newest view, not this drawing's: a folder Claude opened since stays open.
    const toggle = async (path: string) => {
      await update($, view, old => ({
        ...old,
        expanded: old.expanded.includes(path) ? old.expanded.filter(one => one !== path) : [...old.expanded, path],
      }))
      redraw($)
    }

    // A file's actions, behind the ⋯ at the end of its row: open under the row for one file at a
    // time, in the list it was pressed in. A diff belongs to the actions it was opened from.
    const isActing = (where: Menu['where'], abs: string) => acts?.path === abs && acts.where === where
    const closeActions = async () => {
      await update($, menu, () => null)
      await update($, diff, () => null)
      redraw($)
    }
    // An opened menu, or one a submenu made taller, is scrolled into sight whole.
    const showActions = (where: Menu['where'], abs: string) =>
      $.ui.scroll({ in: PANE, to: { key: `actions:${where}:${abs}` }, block: 'nearest' }).catch(() => ({}))
    const toggleActions = async (where: Menu['where'], abs: string) => {
      const next = await update($, menu, old => (old?.path === abs && old.where === where ? null : { path: abs, where, sub: null }))
      await update($, diff, () => null)
      redraw($)
      if (next) void showActions(where, abs)
    }
    // One submenu open at a time, as in a native menu: opening one folds the other.
    const toggleSub = async (sub: Menu['sub']) => {
      const next = await update($, menu, old => old && { ...old, sub: old.sub === sub ? null : sub })
      redraw($)
      if (next) void showActions(next.where, next.path)
    }

    // The file in the tree, wherever the tree is: in its own project (the tree moves there, as it
    // follows Claude), at a folder that holds it, its folders opened down to it, search cleared, and
    // its row in sight.
    const showInTree = async (abs: string) => {
      const path = await follow($, cwd, abs, true)

      await update($, view, old => ({ ...old, query: '' }))
      await closeActions()
      if (path) void reveal($, path)
    }

    // Every file git reports changed, in sight in the tree: search cleared, the folders down to each
    // opened, the first scrolled to. The tree goes to the project's top when one is outside the
    // folder it shows. A deleted file has no row, so opens nothing.
    const showChanged = async () => {
      const paths = g?.changed ?? []

      await update($, view, old => {
        const start = paths.every(path => isUnder(old.dir, path)) ? { ...old, query: '' } : { ...old, query: '', dir: '' }

        return { ...start, expanded: [...new Set([...start.expanded, ...paths.flatMap(path => closedAbove(start, path))])] }
      })
      redraw($)
      if (paths[0]) void reveal($, paths[0])
    }

    // A surface that paints (not the terminal, where a border is box-drawing characters three rows
    // tall): it gets rounded pills and rows, soft cards and moving badges.
    const isRich = Svg !== null
    // A surface that paints and also lays a Box over another (`position="absolute"`) and draws a
    // `plain` Button without chrome: a row's press layer and shimmer need both. Today's VS Code
    // webview does neither, so a layer there flows under its row as a filled button of its own;
    // there a row is pressed by its caret, and a menu's items are Buttons, as on the terminal.
    const canLayer = isRich && e.surface !== 'vscode'
    // The small step between things. VS Code draws the named step `xs` as a whole cell across and
    // none down, so chips that wrap touch and a card's lines sit flush; half a cell, both ways, there.
    const xs: Space = e.surface === 'vscode' ? 0.5 : 'xs'
    // A bordered Box is what the desktop rounds; a clear border keeps the corner without a line.
    const rounded = (color = CLEAR) => (isRich ? ({ borderStyle: 'round', borderColor: color } as const) : {})
    // The terminal draws a color's alpha as if it were opaque: a tint there is a solid block in the
    // color of the text on it, which hides the text. So it gets no tint, and its edges are gray.
    const edge = isRich ? CARD_EDGE : MUTED

    // Every Svg names itself in `alt`: the desktop drops one whose alt is empty.
    const icon = (source: string, alt: string, glyph: string, color: string, size = 18) =>
      Svg ? <Svg source={source} alt={alt} width={size} height={size} /> : <Text color={color}>{glyph}</Text>

    // A file's icon: its vscode-icons SVG, or on the terminal a chip naming its type. Every chip is
    // as wide as the longest label (`HTML`), so the names after them start in one column.
    const chip = (name: string) => {
      if (Svg) return <Svg source={fileIcon(name)} alt={name} width={16} height={16} />

      const [label, color] = kindOf(name)

      return (
        <Text color={color} mono size="caption" weight="semibold">
          {label.padEnd(4)}
        </Text>
      )
    }

    // A toolbar action: a small rounded chip, dim at rest, tinted with a check while the setting it
    // switches is on, the check in its glyph's place. The desktop draws the Button inside with its
    // own padding, so the chip adds none and the label is caption-sized: the row stays one line in a
    // narrow pane.
    const tool = (key: string, label: string, onPress: () => unknown, state: 'on' | 'off' | 'idle' = 'off', glyph = '') => {
      const mark = state === 'on' ? '✓' : glyph
      const button = (
        <Button key={key} plain dimColor={state !== 'on'} onPress={onPress}>
          <Text size="caption">{mark ? `${mark} ${label}` : label}</Text>
        </Button>
      )

      return isRich ? (
        <Box
          key={`chip:${key}`}
          {...rounded(state === 'on' ? tint(FOLDER, '59') : CARD_EDGE)}
          backgroundColor={state === 'on' ? tint(FOLDER, '1f') : undefined}
          paddingX={0}
          paddingY={0}
          flexShrink={0}
          hover={{ backgroundColor: state === 'on' ? tint(FOLDER, '2e') : HOVER }}
        >
          {button}
        </Box>
      ) : (
        button
      )
    }

    // The ⋯ at the end of a file's row: a press opens the file's actions under it, or closes them.
    // The desktop pads a Button itself, so a row ending in one keeps no right padding of its own:
    // the ⋯ reaches the row's end, where a folder row's count sits.
    const more = (where: Menu['where'], abs: string) => (
      <Button key={`more:${where}:${abs}`} plain dimColor={!isActing(where, abs)} onPress={() => toggleActions(where, abs)}>
        <Text size="footnote">⋯</Text>
      </Button>
    )

    // A diff as an editor shows one, a row a line: its number in the file, the change's mark, the
    // line cut at the row's end. Where the surface paints, an added or removed row is tinted;
    // the terminal colours its text instead. Each hunk opens on the line it starts at and the
    // function around it, as git names it.
    const diffView = (text: string, id: string) => {
      const rows = rowsOf(text)
      const digits = String(Math.max(...rows.map(row => row.line))).length
      const number = (n: number | null) => (n === null ? '' : String(n)).padStart(digits, '\u00a0')
      const MARKS = { add: '+', del: '−', same: '\u00a0' } as const

      return (
        <Box key={`diffview:${id}`} flexDirection="column" {...rounded(CARD_EDGE)} paddingY={xs} overflow="hidden">
          {rows.map((row, i) =>
            row.kind === 'hunk' ? (
              <Box key={`hunk:${id}:${i}`} gap={1} paddingX={1} marginTop={i === 0 ? undefined : xs} overflow="hidden">
                <Text mono dimColor size="footnote">
                  {number(null)}
                </Text>
                <Text dimColor size="footnote" wrap="truncate-end">
                  {row.context ? `Line ${row.line} · ${row.context}` : `Line ${row.line}`}
                </Text>
              </Box>
            ) : (
              <Box
                key={`line:${id}:${i}`}
                gap={1}
                paddingX={1}
                overflow="hidden"
                backgroundColor={isRich && row.kind !== 'same' ? tint(row.kind === 'add' ? ADDED : REMOVED, '1f') : undefined}
              >
                <Text mono dimColor size="footnote">
                  {number(row.line)}
                </Text>
                <Text mono size="footnote" color={row.kind === 'add' ? ADDED : row.kind === 'del' ? REMOVED : undefined} dimColor={row.kind === 'same'}>
                  {MARKS[row.kind]}
                </Text>
                <Box flexShrink={1} minWidth={0} overflow="hidden">
                  <Text
                    mono
                    size="footnote"
                    wrap="truncate-end"
                    color={isRich || row.kind === 'same' ? undefined : row.kind === 'add' ? ADDED : REMOVED}
                    dimColor={row.kind === 'same' && !isRich}
                  >
                    {/* A line cut at its end draws on one line, where spaces would collapse: its indent
                        is held in non-breaking ones. */}
                    {row.text.replace(/^ +/, lead => '\u00a0'.repeat(lead.length)) || '\u00a0'}
                  </Text>
                </Box>
              </Box>
            ),
          )}
        </Box>
      )
    }

    // A file's row and, while its ⋯ is pressed, its actions in a popover over the row above, at the
    // ⋯'s end, laid out as the app's own menus are: put it in the prompt and copy its path; see its
    // diff (a file git reports as changed) and, from another list, find it in the tree; open it in
    // an editor installed on the host, or in Finder or Explorer. Then the diff itself, under the row
    // while open.
    // The popover hangs off a Box around the row, as the row clips what it holds; it floats over the
    // rows before it, which an absolute Box is painted over, and moves none of them.
    // While a menu is open, a press on any file's row closes it, as a click away does a native menu's,
    // the ⋯ included: a layer over the row takes the press. (A press on any other control in the
    // pane closes it too, in register.tsx, and so does one on the pane's plain parts, `away`.)
    const withActions = (row: JSX.Element, where: Menu['where'], abs: string, canDiff: boolean, indent = 0): JSX.Element[] => {
      const away = acts ? pressAnywhere(`away:${where}:${abs}`, closeActions) : null
      if (!isActing(where, abs))
        return away
          ? [
              <Box key={`away:${where}:${abs}`} flexDirection="column" overflow="hidden">
                {row}
                {away}
              </Box>,
            ]
          : [row]

      const name = rel(cwd, abs)
      const isDiff = canDiff && open?.path === abs
      const id = `${where}:${abs}`
      const sub = acts?.sub ?? null
      // What runs on the host is offered only where the person sits at it: not from a phone.
      const editors = e.surface === 'mobile' ? [] : (host?.editors ?? [])
      const folder = e.surface !== 'mobile' && host ? folderApp(host) : null
      const mention = async () => {
        await $.prompt.fill({ text: `@${name.includes(' ') ? `"${name}"` : name} `, mode: 'insert' }).catch(() => {})
        await closeActions()
      }
      // A path copied as the host spells it: with `\` on Windows.
      const asHost = (path: string) => (isWindowsPath(cwd) ? backslashed(path) : path)
      const copy = (text: string) => async (press: { surface: typeof e.surface }) => {
        await $.ui.copy({ text, surface: press.surface }).catch(() => {})
        $.ui.toast(`Copied ${text}`)
        await closeActions()
      }
      // A launch that fails says so; one that works shows the app.
      const launch = (label: string, run: () => Promise<boolean>) => async () => {
        await closeActions()
        if (!(await run())) $.ui.toast(`Could not open ${base(abs)} in ${label}`)
      }

      // The menu's rows in their groups, a divider between each two. A submenu's rows follow its own,
      // one step in, while it is open. Laid out first, so the menu can be as wide as its longest row:
      // the terminal draws a divider to that width.
      type Item = {
        key: string
        label: string
        onPress: (press: { surface: typeof e.surface }) => unknown
        isSub?: boolean
        isOpen?: boolean
        depth?: number
      }
      const groups: Item[][] = [
        [
          { key: 'mention', label: '@ Mention', onPress: mention },
          { key: 'copy', label: 'Copy', onPress: () => toggleSub('copy'), isSub: true, isOpen: sub === 'copy' },
          ...(sub === 'copy'
            ? [
                { key: 'copy-abs', label: 'Absolute path', onPress: copy(asHost(abs)), depth: 1 },
                { key: 'copy-rel', label: 'Relative path', onPress: copy(asHost(name)), depth: 1 },
                { key: 'copy-name', label: 'Filename', onPress: copy(base(abs)), depth: 1 },
              ]
            : []),
        ],
        [
          ...(canDiff ? [{ key: 'diff', label: isDiff ? 'Hide diff' : 'Diff', onPress: () => toggleDiff($, abs) }] : []),
          ...(where !== 'tree' ? [{ key: 'show', label: 'Show in tree', onPress: () => showInTree(abs) }] : []),
        ],
        [
          ...(editors.length > 0 ? [{ key: 'open', label: 'Open in', onPress: () => toggleSub('open'), isSub: true, isOpen: sub === 'open' }] : []),
          ...(sub === 'open' && host
            ? editors.map(editor => ({ key: `open-${editor.cli}`, label: editor.name, onPress: launch(editor.name, () => openIn($, host, editor, abs)), depth: 1 }))
            : []),
          ...(folder && host ? [{ key: 'folder', label: `Show in ${folder}`, onPress: launch(folder, () => showInFolder($, host, abs)) }] : []),
        ],
      ].filter(group => group.length > 0)
      // In cells: the longest row, its indent and chevron, and each row's padding either side.
      const inner = Math.max(...groups.flat().map(item => 2 * (item.depth ?? 0) + item.label.length + (item.isSub ? 3 : 0)))
      const width = inner + 2 + (isRich ? 4 : 0)

      // A row lights under the pointer, as a native menu's does, and a press anywhere on it counts;
      // a submenu's chevron turns down while it is open.
      const item = ({ key, label, onPress, isSub, isOpen, depth = 0 }: Item) => (
        <Box
          key={`item:${key}:${id}`}
          {...rounded()}
          justifyContent="space-between"
          alignItems="center"
          gap={1}
          paddingLeft={1 + 2 * depth}
          paddingRight={1}
          paddingY={0}
          overflow="hidden"
          hover={{ backgroundColor: HOVER }}
        >
          {canLayer ? (
            <Text size="footnote">{label}</Text>
          ) : (
            <Button key={`${key}:${id}`} plain onPress={onPress}>
              <Text size="footnote">{label}</Text>
            </Button>
          )}
          {isSub && icon(chevronSvg(isOpen === true), isOpen ? 'open' : 'closed', CARETS[isOpen ? 1 : 0], MUTED, 12)}
          {pressAnywhere(`${key}:${id}`, onPress)}
        </Box>
      )
      // A thin line between groups: a hairline where the surface paints, a row of box-drawing ones
      // across the menu on the terminal.
      const divider = (i: number) =>
        Svg ? (
          <Box key={`rule:${i}:${id}`} paddingX={1} paddingY={xs}>
            <Svg source={RULE_SVG} alt="divider" height={1} />
          </Box>
        ) : (
          <Text key={`rule:${i}:${id}`} color={edge}>
            {'─'.repeat(width)}
          </Text>
        )

      return [
        <Box key={`acting:${id}`} flexDirection="column">
          {/* The row clips the layer that reaches past its end, as any row's does; the popover,
              beside them, hangs outside it. */}
          <Box flexDirection="column" overflow="hidden">
            {row}
            {away}
          </Box>
          <Box
            key={`actions:${id}`}
            position="absolute"
            bottom={1}
            right={0}
            width={width}
            {...rounded(CARD_EDGE)}
            backgroundColor={CARD}
            flexDirection="column"
            alignItems="stretch"
            paddingX={isRich ? xs : 0}
            paddingY={xs}
          >
            {groups.flatMap((group, i) => [...(i > 0 ? [divider(i)] : []), ...group.map(item)])}
          </Box>
        </Box>,
        ...(isDiff && open
          ? [
              <Box key={`diff:${id}`} flexDirection="column" gap={xs} paddingLeft={indent + 1} paddingRight={1}>
                {open.text ? (
                  diffView(open.text, id)
                ) : (
                  <Text dimColor size="footnote">
                    No changes since the last commit.
                  </Text>
                )}
                {open.more > 0 && (
                  <Text dimColor size="footnote">
                    {plural(open.more, 'more line')} not shown
                  </Text>
                )}
              </Box>,
            ]
          : []),
      ]
    }

    // A folder's chevron, which a file row draws blank so a file's icon lines up with a folder's.
    // Where the surface paints it is a thin SVG stroke, and a press on the row opens it; only a
    // Button takes a press and a Button holds only text, so the terminal's is a glyph, and so is a
    // surface's that lays no press over the row: a glyph as wide as its Button draws it.
    const chevron = (isOpen = false, onPress?: () => unknown, key?: string) =>
      Svg && (canLayer || !onPress) ? (
        <Svg source={onPress ? chevronSvg(isOpen) : BLANK_SVG} alt={onPress ? (isOpen ? 'open' : 'closed') : 'file'} width={12} height={12} />
      ) : (
        <Box width={isRich ? undefined : 2} flexShrink={0} justifyContent="center" alignItems="center">
          {onPress && (
            <Button key={key} plain dimColor onPress={onPress}>
              <Text mono size="caption">
                {CARETS[isOpen ? 1 : 0]}
              </Text>
            </Button>
          )}
        </Box>
      )

    // A press anywhere on a row (a folder's, a menu's), where the surface paints: a Button holds
    // only text, so a row with icons cannot be one. Laid over the row instead, a Button of blank text far wider than
    // any row, so the Button covers the row end to end. (Non-breaking spaces, which a surface does
    // not collapse.) The desktop draws a Button's text on one line, cut to its room with an ellipsis
    // in the Button's own color, which no Text prop hides; so the layer reaches a pane's width past
    // the row's end, and the ellipsis falls there, where the row clips it. No `label`: the desktop
    // draws a label as text, over the chevron and the icon; the key is its address.
    const pressAnywhere = (key: string, onPress: (press: { surface: typeof e.surface }) => unknown) =>
      canLayer ? (
        <Box position="absolute" top={0} left={0} right={-e.props.bodyColumns} bottom={0} flexDirection="column" overflow="hidden">
          <Button key={key} plain onPress={onPress}>
            <Text color={CLEAR}>{'\u00a0'.repeat(Math.max(600, e.props.bodyColumns * 12))}</Text>
          </Button>
        </Box>
      ) : null

    // A press on a plain part of the pane (the card, a section's title, a note), where no control
    // sits, closes a file's menu too: while one is open, a layer over the part takes the press. The
    // part clips the layer, so it holds `overflow="hidden"`.
    const pressAway = (key: string) => (acts ? pressAnywhere(`away:${key}`, closeActions) : null)

    const dot = (color: string, isLive = false, size = 12) =>
      Svg ? <Svg source={dotSvg(color, isLive)} alt={isLive ? 'live' : 'mark'} width={size} height={size} /> : <Text color={color}>●</Text>

    // The shimmer over a row, laid on top of it and clipped by it: the row is `overflow="hidden"`.
    // Wider and taller than any row, so it always covers; the row cuts it to size.
    const sweepWidth = Math.min(4096, Math.max(240, e.props.bodyColumns * 10))
    const shimmer = (color: string, height = 48) =>
      Svg && canLayer ? (
        <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
          <Svg source={shimmerSvg(color, sweepWidth, height)} alt="working" width={sweepWidth} height={height} />
        </Box>
      ) : null

    // A rounded chip of a color's tint, a live one with a pulsing dot. It never shrinks, which would
    // wrap its label ("0 / files") in a narrow header.
    // Given a press, the pill is a control: it lights under the pointer, a press anywhere on it counts.
    const pill = (label: string, color: string, isLive = false, press?: { key: string; onPress: () => unknown }) =>
      isRich && (canLayer || !press) ? (
        <Box
          key={press ? `pill:${press.key}` : undefined}
          {...rounded(tint(color, '4d'))}
          backgroundColor={tint(color, '1f')}
          paddingX={1}
          paddingY={0}
          gap={xs}
          alignItems="center"
          flexShrink={0}
          {...(press ? { overflow: 'hidden', hover: { backgroundColor: tint(color, '3d') } } : {})}
        >
          {isLive && dot(color, true)}
          <Text color={color} size="footnote" weight="semibold">
            {label}
          </Text>
          {press && pressAnywhere(press.key, press.onPress)}
        </Box>
      ) : press ? (
        <Button key={press.key} plain onPress={press.onPress}>
          <Text color={color} size="footnote" weight="semibold">
            {` ${label} `}
          </Text>
        </Button>
      ) : (
        <Text color={color} size="footnote" weight="semibold">
          {` ${label} `}
        </Text>
      )

    // A folder's name in a pill: unlike a count, it can be any length, so in a narrow header it gives
    // way, cut with an ellipsis.
    const place = (name: string) =>
      isRich ? (
        <Box {...rounded(tint(MUTED, '4d'))} backgroundColor={tint(MUTED, '1f')} paddingX={1} paddingY={0} flexShrink={1} minWidth={0} overflow="hidden">
          <Text color={MUTED} size="footnote" weight="semibold" wrap="truncate-end">
            {name}
          </Text>
        </Box>
      ) : (
        <Text dimColor size="caption" wrap="truncate-end">
          {name}
        </Text>
      )

    const counts = (path: string) => {
      const pair = g?.lines[path]

      if (!pair) return null

      return (
        <Text size="footnote" tabular>
          <Text color={ADDED}>+{pair[0]}</Text> <Text color={REMOVED}>−{pair[1]}</Text>
        </Text>
      )
    }

    // The letter git gives a changed file (M, A, D, R, U, C), as the project shown spells its path.
    // The name takes Claude's color while Claude has the file, so this is what still says git has
    // the file changed.
    const mark = (path: string | null) => {
      const letter = path === null ? undefined : g?.marks[path]

      return letter ? (
        <Text color={DIRTY} size="footnote" weight="semibold">
          {letter}
        </Text>
      ) : null
    }

    // The accent a touched file carries: green once committed, orange once edited, purple once read.
    const accentOf = (one: Touch) => (one.isCommitted ? DONE : one.isEdited ? EDIT : READ)

    const card = (() => {
      if (cur === null) {
        return {
          kicker: 'RIGHT NOW',
          color: MUTED,
          glyph: 'idle' as const,
          motion: 'breathe' as const,
          title: 'Waiting for Claude',
          sub: 'nothing touched yet',
        }
      }

      if (cur.verb === 'thinking') {
        const opened = list.filter(one => !one.isEdited).length

        return {
          kicker: 'RIGHT NOW',
          color: MUTED,
          glyph: 'spark' as const,
          motion: 'spin' as const,
          title: 'Claude is thinking',
          sub: cur.thought ? (
            <Text dimColor italic size="footnote" wrap="truncate-start">
              {cur.thought}
            </Text>
          ) : opened > 0 ? (
            `opened ${plural(opened, 'file')}`
          ) : (
            `in ${project}`
          ),
        }
      }

      if (cur.verb === 'writing') {
        return {
          kicker: 'RIGHT NOW',
          color: WRITE,
          glyph: 'quill' as const,
          motion: 'pulse' as const,
          title: 'Claude is writing',
          sub: (
            <Text dimColor size="footnote" wrap="truncate-start">
              {cur.text}
            </Text>
          ),
        }
      }

      if (cur.verb === 'working') {
        return {
          kicker: 'RIGHT NOW',
          color: TOOL,
          glyph: glyphOf(cur.tool),
          motion: 'pulse' as const,
          title: cur.title,
          sub: cur.detail ? (
            <Text dimColor mono size="footnote" wrap="truncate-end">
              {cur.detail}
            </Text>
          ) : (
            cur.tool
          ),
        }
      }

      if (cur.verb === 'committed') {
        return {
          kicker: 'DONE',
          color: DONE,
          glyph: 'check' as const,
          motion: 'draw' as const,
          title: `Claude committed ${plural(cur.files.length, 'file')}`,
          sub: cur.hash,
        }
      }

      if (cur.verb === 'done') {
        if (cur.edited.length === 0) {
          return {
            kicker: 'DONE',
            color: DONE,
            glyph: 'check' as const,
            motion: 'draw' as const,
            title: cur.read.length > 0 ? `Claude read ${plural(cur.read.length, 'file')}` : 'Claude touched no files',
            sub: 'nothing changed',
          }
        }

        // One edited file names its path and, in git, its line counts; otherwise names and what was opened.
        const one = cur.edited.length === 1 ? cur.edited[0]! : null
        const pair = one ? g?.lines[one] : undefined
        const folders = new Set(cur.read.map(dirOf))
        const where = folders.size === 1 && [...folders][0] ? base([...folders][0]!) : 'files'
        const opened = cur.read.length > 0 ? `, opened ${cur.read.length} ${cur.read.length === 1 && where === 'files' ? 'file' : where}` : ''

        return {
          kicker: 'DONE',
          color: EDIT,
          glyph: 'pencil' as const,
          motion: 'draw' as const,
          title: `Claude edited ${plural(cur.edited.length, 'file')}`,
          sub:
            one && pair ? (
              <Text dimColor size="footnote" wrap="truncate-end">
                {one} <Text color={ADDED}>+{pair[0]}</Text> <Text color={REMOVED}>−{pair[1]}</Text>
              </Text>
            ) : (
              <Text dimColor size="footnote" wrap="truncate-end">
                {cur.edited.slice(0, 2).map(base).join(', ')}
                {cur.edited.length > 2 ? ` and ${cur.edited.length - 2} more` : ''}
                {opened}
              </Text>
            ),
        }
      }

      const isEdit = cur.verb === 'editing'

      return {
        kicker: 'RIGHT NOW',
        color: isEdit ? EDIT : READ,
        glyph: isEdit ? ('pencil' as const) : ('eye' as const),
        motion: 'pulse' as const,
        title: `Claude is ${cur.verb} ${base(cur.path)}`,
        sub: `in ${where(dirOf(cur.path)) || project}`,
      }
    })()

    // What git ignores draws dim, as in VS Code's explorer: the path itself or a folder above it.
    const ignored = new Set(g?.ignored ?? [])
    const isIgnored = (path: string, isDir: boolean) => {
      if (ignored.has(isDir ? `${path}/` : path)) return true

      const parts = path.split('/')

      return parts.slice(0, -1).some((_, i) => ignored.has(`${parts.slice(0, i + 1).join('/')}/`))
    }

    // A folder's changed files under it, for its count and its icon's color.
    const changedUnder = (dir: string) => (g?.changed ?? []).filter(one => one.startsWith(`${dir}/`)).length
    // The touched file under a folder that Claude has in hand, for the folder's name color.
    const activeUnder = (dir: string) => list.find(one => one.isActive && (keyOf(one.path) ?? '').startsWith(`${dir}/`))

    // The tree under v.dir, open folders listed in place, up to TREE_ROWS rows.
    const rows: JSX.Element[] = []
    const walk = async (dir: string, depth: number): Promise<void> => {
      const entries = await listDir($, listPath(home, dir))
      const sorted = entries
        .filter(entry => !SKIP.has(entry.name) || v.showHidden)
        .filter(entry => v.showHidden || !entry.name.startsWith('.'))
        .sort((a, b) => Number(b.kind === 'dir') - Number(a.kind === 'dir') || a.name.localeCompare(b.name))
      // A file keeps the chevron's width only to line up with a folder beside it.
      const hasDirs = sorted.some(entry => entry.kind === 'dir')
      for (const entry of sorted) {
        if (rows.length >= TREE_ROWS) return

        const path = join(dir, entry.name)
        const indent = depth * 2

        if (entry.kind === 'dir') {
          const isOpen = v.expanded.includes(path)
          const count = SKIP.has(entry.name) ? 0 : changedUnder(path)
          const active = activeUnder(path)
          const folderColor = entry.name.startsWith('.') ? MUTED : count > 0 ? EDIT : FOLDER
          const name = (
            <Text color={active ? accentOf(active) : count > 0 ? DIRTY : undefined} dimColor={!active && count === 0 && isIgnored(path, true)}>
              {entry.name}
            </Text>
          )

          rows.push(
            <Box
              key={`row:${path}`}
              {...rounded()}
              justifyContent="space-between"
              alignItems="center"
              gap={1}
              paddingX={1}
              paddingY={0}
              overflow="hidden"
              hover={{ backgroundColor: HOVER }}
            >
              <Box gap={1} alignItems="center" paddingLeft={indent} flexShrink={1} minWidth={0} overflow="hidden">
                {/* The chevron sits close to the folder's icon; a press on it or the name opens it. */}
                <Box gap={xs} alignItems="center">
                  {chevron(isOpen, () => toggle(path), `caret:${path}`)}
                  {icon(folderIcon(entry.name, isOpen), entry.name, '▪', folderColor, 16)}
                </Box>
                {/* Where the surface paints but lays no press over the row, a Button is filled: the
                    name is text there, and the caret takes the press. */}
                {isRich && !canLayer ? (
                  name
                ) : (
                  <Button key={`dir:${path}`} plain onPress={() => toggle(path)}>
                    {name}
                  </Button>
                )}
              </Box>
              {(active || count > 0) && (
                <Box flexShrink={0} gap={xs} alignItems="center">
                  {active && dot(accentOf(active), true)}
                  {count > 0 && (
                    <Text color={DIRTY} size="footnote" tabular>
                      {count}
                    </Text>
                  )}
                </Box>
              )}
              {pressAnywhere(`fold:${path}`, () => toggle(path))}
            </Box>,
          )

          if (isOpen && depth < 12) await walk(path, depth + 1)
        } else {
          const touch = byPath.get(path)
          const isDirty = changed.has(path)
          const accent = touch ? accentOf(touch) : isDirty ? DIRTY : undefined
          // The row's tint: strong while Claude has the file or just committed it, faint once it let go.
          const background = touch && isRich ? tint(accentOf(touch), touch.isActive || touch.isCommitted ? '2e' : '14') : undefined
          // No pill for what Claude is doing with the file: the row's tint and shimmer say it.
          const right = (() => {
            if (isDirty && g?.lines[path]) return counts(path)
            if (v.showSizes) return <Text dimColor tabular size="footnote">{sizeOf(entry.size)}</Text>

            return null
          })()

          const row = (
            <Box
              key={`row:${path}`}
              {...rounded(touch?.isActive ? tint(accentOf(touch), '59') : CLEAR)}
              justifyContent="space-between"
              alignItems="center"
              gap={1}
              paddingLeft={1}
              paddingRight={0}
              paddingY={0}
              backgroundColor={background}
              overflow="hidden"
              hover={{ backgroundColor: background ?? HOVER }}
            >
              {touch?.isActive && shimmer(accentOf(touch))}
              <Box gap={1} alignItems="center" paddingLeft={indent} flexShrink={1} minWidth={0} overflow="hidden">
                {/* The chevron's width, unseen, so a file's icon lines up with a sibling folder's. */}
                <Box gap={xs} alignItems="center">
                  {hasDirs && chevron()}
                  {chip(entry.name)}
                </Box>
                <Text
                  color={accent}
                  dimColor={!accent && isIgnored(path, false)}
                  weight={touch?.isActive || touch?.isCommitted || isDirty ? 'semibold' : undefined}
                  wrap="truncate-end"
                >
                  {entry.name}
                </Text>
              </Box>
              <Box flexShrink={0} gap={1} alignItems="center">
                {right}
                {mark(path)}
                {more('tree', join(home, path))}
              </Box>
            </Box>
          )

          rows.push(...withActions(row, 'tree', join(home, path), isDirty, indent))
        }
      }
    }

    // The way up, the tree's first row: the folder above the one shown, past the project's top too.
    const upRow = (
      <Box key="row:.." {...rounded()} alignItems="center" gap={1} paddingX={1} paddingY={0} overflow="hidden" hover={{ backgroundColor: HOVER }}>
        <Box gap={xs} alignItems="center">
          {chevron()}
          {icon(folderIcon('..', false), 'up', '▪', MUTED, 16)}
        </Box>
        <Button key="up" plain dimColor onPress={() => setView({ dir: parentOf(v.dir), expanded: [] })}>
          ..
        </Button>
        {pressAnywhere('up:row', () => setView({ dir: parentOf(v.dir), expanded: [] }))}
      </Box>
    )

    const query = v.query.trim().toLowerCase()
    const matches = query ? rank(await indexFiles($, home), query, MATCHES) : []

    if (!query) await walk(v.dir, 0)

    const totals = Object.values(g?.lines ?? {}).reduce<[number, number]>(([a, d], [x, y]) => [a + x, d + y], [0, 0])

    // A section's head: its name in small caps and, beside it, a quiet count or place, or controls.
    // In a narrow pane the name gives way first: its weight is far above the aside's, which shrinks
    // only once the name is gone, and then only where it holds a place.
    const head = (title: string, aside: string | JSX.Element) => (
      <Box justifyContent="space-between" alignItems="center" gap={1} paddingX={1}>
        <Box flexShrink={1000} minWidth={0} overflow="hidden">
          <Text dimColor weight="bold" size="caption" wrap="truncate-end">
            {title}
          </Text>
          {pressAway(`head:${title}`)}
        </Box>
        <Box flexShrink={1} minWidth={0}>
          {typeof aside !== 'string' ? aside : isRich ? pill(aside, MUTED) : <Text dimColor size="caption">{aside}</Text>}
        </Box>
      </Box>
    )

    // The touched list: this turn's files, or with the whole session's, the earlier turns' first.
    const isSession = sc === 'session'
    const shownTouched = isSession ? [...prior.filter(one => !list.some(now => now.path === one.path)), ...list] : list
    // A long list shows its newest files and folds the older ones into a row that opens them; a
    // file Claude has in hand, or whose actions are open, shows wherever it sits.
    const isFolded = shownTouched.length > TOUCHED_ROWS && !isAll
    const newest = shownTouched.slice(-TOUCHED_ROWS)
    const keptTouched = isFolded ? shownTouched.filter(one => newest.includes(one) || one.isActive || acts?.path === absOf(cwd, one.path)) : shownTouched
    const foldedCount = shownTouched.length - keptTouched.length

    // While Claude is idle the card sits on the theme's soft surface; otherwise on its state's tint.
    const isIdle = card.color === MUTED

    return (
      <Box flexDirection="column" gap={1}>
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={isIdle ? edge : isRich ? tint(card.color, '66') : card.color}
          backgroundColor={isRich ? (isIdle ? CARD : tint(card.color, '14')) : undefined}
          overflow="hidden"
          gap={1}
        >
          {card.motion === 'pulse' && shimmer(card.color, 400)}
          <Box gap={1} alignItems="center" overflow="hidden">
            {Svg ? (
              <Svg source={badgeSvg(card.glyph, card.color, card.motion, cardSince())} alt={card.kicker} width={56} height={56} />
            ) : (
              <Text color={card.color}>{TEXT_GLYPH[card.glyph]}</Text>
            )}
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Text color={card.color} weight="bold" size="caption">
                {card.kicker}
              </Text>
              <Text weight="bold" size="heading" wrap="truncate-end">
                {card.title}
              </Text>
              {typeof card.sub === 'string' ? (
                <Text dimColor size="footnote" wrap="truncate-end">
                  {card.sub}
                </Text>
              ) : (
                card.sub
              )}
            </Box>
            {pressAway('card')}
          </Box>

          {g !== null && (
            <Box
              {...rounded(CARD_EDGE)}
              backgroundColor={isRich ? HOVER : undefined}
              justifyContent="space-between"
              alignItems="center"
              gap={1}
              paddingX={1}
              paddingY={isRich ? xs : 0}
              flexWrap="wrap"
            >
              <Box gap={xs} alignItems="center" overflow="hidden">
                {icon(BRANCH_SVG, 'branch', '⎇', READ, 16)}
                <Text weight="semibold">{g.branch}</Text>
                {g.ahead ? pill(`↑${g.ahead}`, DONE) : null}
                {pressAway('branch')}
              </Box>
              {g.changed.length === 0 ? (
                <Text dimColor size="footnote">
                  clean, nothing changed
                </Text>
              ) : (
                <Box gap={xs} alignItems="center">
                  {totals[0] > 0 && pill(`+${totals[0]}`, ADDED)}
                  {totals[1] > 0 && pill(`−${totals[1]}`, REMOVED)}
                  {pill(`${g.changed.length} changed`, DIRTY, false, { key: 'changed', onPress: showChanged })}
                </Box>
              )}
            </Box>
          )}

          <Box columnGap={2} rowGap={0} flexWrap="wrap" overflow="hidden">
            <Box gap={xs} alignItems="center">
              {dot(READ)}
              <Text dimColor size="footnote">
                Claude read
              </Text>
            </Box>
            <Box gap={xs} alignItems="center">
              {dot(EDIT)}
              <Text dimColor size="footnote">
                Claude edited
              </Text>
            </Box>
            {g !== null && (
              <Box gap={xs} alignItems="center">
                {dot(DIRTY)}
                <Text dimColor size="footnote">
                  Not committed
                </Text>
              </Box>
            )}
            {pressAway('legend')}
          </Box>
        </Box>

        {Input && (
          <Input
            key="find"
            placeholder="Find a file"
            value={v.query}
            onInput={(value: string) => setView({ query: value })}
            onSubmit={(value: string) => setView({ query: value })}
          />
        )}

        <Box gap={xs} flexWrap="wrap" paddingX={1} alignItems="center">
          {tool('refresh', '↻ Refresh', async () => {
            forget()
            await refreshGit($)
            await update($, tick, n => n + 1)
            redraw($)
          })}
          {tool('collapse', '⊟ Collapse', () => setView({ expanded: [] }), v.expanded.length === 0 ? 'idle' : 'off')}
          {tool('sizes', 'Sizes', () => setView({ showSizes: !v.showSizes }), v.showSizes ? 'on' : 'off', '⇲')}
          {tool('hidden', 'Dotfiles', () => setView({ showHidden: !v.showHidden }), v.showHidden ? 'on' : 'off', '◌')}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={edge} backgroundColor={isRich ? CARD : undefined} gap={xs}>
          {head(
            'CLAUDE TOUCHED',
            <Box gap={xs} alignItems="center">
              {tool(
                'scope',
                'Whole session',
                async () => {
                  await update($, scope, old => (old === 'session' ? 'turn' : 'session'))
                  redraw($)
                },
                isSession ? 'on' : 'off',
              )}
              {isRich ? pill(plural(shownTouched.length, 'file'), MUTED) : <Text dimColor size="caption">{plural(shownTouched.length, 'file')}</Text>}
            </Box>,
          )}
          {shownTouched.length === 0 && (
            <Box paddingX={1} overflow="hidden">
              <Text dimColor>Nothing yet</Text>
              {pressAway('none')}
            </Box>
          )}
          {/* The older files, folded above the newest; opened, the same row folds them again. It
              says "more", never "earlier": Whole session already means the earlier turns' files. */}
          {(isFolded ? foldedCount > 0 : shownTouched.length > TOUCHED_ROWS) && (
            <Box key="touched-fold" paddingX={1}>
              <Button
                key="touched-all"
                plain
                dimColor
                onPress={async () => {
                  await update($, isTouchedAll, old => !old)
                  redraw($)
                }}
              >
                <Text size="footnote">{isFolded ? `${CARETS[0]} ${foldedCount} more` : `${CARETS[1]} Show fewer`}</Text>
              </Button>
            </Box>
          )}
          {keptTouched.flatMap(one => {
            const abs = absOf(cwd, one.path)
            // A diff for a file with changes not yet committed: as git reports it where git is read,
            // since a commit Claude did not make here (another session's, the app's, the person's)
            // leaves nothing to show; else as Claude left it.
            const key = keyOf(one.path)
            const canDiff = g && key !== null ? changed.has(key) : one.isEdited && !one.isCommitted
            // As in the tree: the tint and shimmer say what Claude did with the file, the name takes its color.
            const background = isRich ? tint(accentOf(one), one.isActive || one.isCommitted ? '2e' : '14') : undefined

            return withActions(
              <Box
                key={`touch:${one.path}`}
                {...rounded(one.isActive ? tint(accentOf(one), '59') : CLEAR)}
                backgroundColor={background}
                justifyContent="space-between"
                alignItems="center"
                gap={1}
                paddingLeft={1}
                paddingRight={0}
                paddingY={0}
                overflow="hidden"
                hover={{ backgroundColor: background ?? HOVER }}
              >
                {one.isActive && shimmer(accentOf(one))}
                {/* One line: the name keeps its room, the folder gives way from its start. */}
                <Box gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
                  {chip(base(one.path))}
                  <Box flexShrink={1}>
                    <Text color={accentOf(one)} weight="semibold" wrap="truncate-end">
                      {base(one.path)}
                    </Text>
                  </Box>
                  <Box flexShrink={8} minWidth={0}>
                    <Text dimColor size="footnote" wrap="truncate-start">
                      {where(dirOf(one.path))}
                    </Text>
                  </Box>
                </Box>
                <Box gap={1} alignItems="center" flexShrink={0}>
                  {one.isEdited && !one.isCommitted && counts(one.path)}
                  {mark(key)}
                  <Text dimColor size="footnote" tabular>
                    {timeOf(one.at)}
                  </Text>
                  {more('touched', abs)}
                </Box>
              </Box>,
              'touched',
              abs,
              canDiff,
            )
          })}
        </Box>

        <Box flexDirection="column" borderStyle="round" borderColor={edge} backgroundColor={isRich ? CARD : undefined} gap={0}>
          {head(
            query ? 'MATCHES' : 'ALL FILES',
            query ? (
              plural(matches.length, 'file')
            ) : v.dir !== '' || v.root !== '' ? (
              <Box gap={xs} alignItems="center" flexShrink={1} minWidth={0}>
                {tool('home', '⌂ Project', () => setView({ root: '', dir: '', expanded: [] }))}
                {place(v.dir ? base(v.dir) : project)}
              </Box>
            ) : (
              place(project)
            ),
          )}
          <Box flexDirection="column" marginTop={xs}>
            {query && matches.length === 0 && (
              <Box paddingX={1} overflow="hidden">
                <Text dimColor>No file matches "{v.query}".</Text>
                {pressAway('no-match')}
              </Box>
            )}
            {matches.flatMap(path =>
              withActions(
                <Box
                  key={`match:${path}`}
                  {...rounded()}
                  justifyContent="space-between"
                  gap={1}
                  alignItems="center"
                  paddingLeft={1}
                  paddingRight={0}
                  paddingY={0}
                  overflow="hidden"
                  hover={{ backgroundColor: HOVER }}
                >
                  <Box gap={1} alignItems="center" flexShrink={1} minWidth={0} overflow="hidden">
                    {chip(base(path))}
                    <Text color={byPath.has(path) ? accentOf(byPath.get(path)!) : changed.has(path) ? DIRTY : undefined} wrap="truncate-start">
                      {path}
                    </Text>
                  </Box>
                  <Box flexShrink={0}>{more('match', join(home, path))}</Box>
                </Box>,
                'match',
                join(home, path),
                changed.has(path),
              ),
            )}
            {!query && upRow}
            {rows}
            {rows.length >= TREE_ROWS && (
              <Box paddingX={1} overflow="hidden">
                <Text dimColor>More files not shown. Search to find them.</Text>
                {pressAway('cut')}
              </Box>
            )}
          </Box>
        </Box>

        {foot && (
          <Box justifyContent="flex-end" paddingX={1}>
            {pill(foot.verb === 'committing' ? 'committing…' : `committed ${foot.hash}`, DONE, foot.verb === 'committing')}
          </Box>
        )}
      </Box>
    )
}
