// How the pane looks: its colors, the chips that name a file's type on the terminal, and the SVG
// it draws where the surface paints (badges, shimmers, dots, chevrons).

// Raw colors, so the pane looks the same whatever the theme. A tint is the color at low alpha.
export const READ = '#ad8cf2'
export const EDIT = '#e8914f'
export const DIRTY = '#e2c07f'
export const DONE = '#72cc82'
export const ADDED = '#72cc82'
export const REMOVED = '#e86f6f'
export const FOLDER = '#7fa7e3'
export const TOOL = '#6cb0f0'
export const WRITE = '#5fb3b3'
export const MUTED = '#8a8a8a'
export const tint = (color: string, alpha = '26') => `${color}${alpha}`
export const HOVER = '#8080801a'
export const CLEAR = '#00000000'
// The soft surfaces cards sit on, from the person's theme, light or dark.
export const CARD = 'userMessageBackground'
export const CARD_EDGE = '#8080802e'

// The chip before a file's name: its type, in that type's color.
const KINDS: Record<string, [string, string]> = {
  js: ['JS', '#e5c07b'],
  jsx: ['JS', '#e5c07b'],
  mjs: ['JS', '#e5c07b'],
  cjs: ['JS', '#e5c07b'],
  ts: ['TS', '#6cb0f0'],
  tsx: ['TS', '#6cb0f0'],
  json: ['{ }', '#98c379'],
  md: ['MD', '#6cb0f0'],
  mdx: ['MD', '#6cb0f0'],
  pdf: ['PDF', '#e06c75'],
  csv: ['CSV', '#98c379'],
  doc: ['DOC', '#6cb0f0'],
  docx: ['DOC', '#6cb0f0'],
  xls: ['XLS', '#98c379'],
  xlsx: ['XLS', '#98c379'],
  css: ['CSS', '#c678dd'],
  html: ['HTML', '#e5a050'],
  py: ['PY', '#6cb0f0'],
  sh: ['SH', '#98c379'],
  yml: ['YML', '#d19a66'],
  yaml: ['YML', '#d19a66'],
  toml: ['TOML', '#d19a66'],
  png: ['IMG', '#c678dd'],
  jpg: ['IMG', '#c678dd'],
  jpeg: ['IMG', '#c678dd'],
  gif: ['IMG', '#c678dd'],
  svg: ['SVG', '#c678dd'],
  webp: ['IMG', '#c678dd'],
  txt: ['TXT', MUTED],
}

export const kindOf = (name: string): [string, string] => {
  if (name.startsWith('.git') || name === '.gitignore') return ['GIT', MUTED]

  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''

  return KINDS[ext] ?? [ext ? ext.slice(0, 3).toUpperCase() : '•', MUTED]
}

// Icons, drawn as SVG where the surface has it; the terminal gets the glyph instead.
// Files and folders wear vscode-icons (icons.ts); the rest are drawn here.
const svg = (size: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`

export const BRANCH_SVG = svg(
  18,
  `<g stroke="${READ}" stroke-width="1.8"><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-11 7"/></g>`,
)

export const GLYPHS = {
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  pencil: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  spark: '<path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/>',
  idle: '<circle cx="12" cy="12" r="6"/>',
  terminal: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M7 10l3 2.5L7 15M12.5 15H17"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M15.5 15.5L20 20"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.6 2.6 14.4 0 17M12 3.5c-2.6 2.6-2.6 14.4 0 17"/>',
  quill: '<path d="M5 19c3-1 6-4 8-7l5-7c-4 1-8 4-10 8-1 2-2 4-3 6z"/><path d="M5 19l5-5"/>',
} as const

export type Glyph = keyof typeof GLYPHS

export const TEXT_GLYPH: Record<Glyph, string> = {
  eye: '◉',
  pencil: '✎',
  check: '✓',
  spark: '✳',
  idle: '○',
  terminal: '❯',
  search: '⌕',
  globe: '◍',
  quill: '✐',
}

// The glyph a tool's card wears.
export const glyphOf = (tool: string): Glyph =>
  tool === 'Bash' ? 'terminal' : tool === 'Grep' || tool === 'Glob' || tool === 'WebSearch' ? 'search' : tool === 'WebFetch' ? 'globe' : 'spark'

// How the badge moves: a halo while Claude has a file, a spinning arc while it thinks, a check
// that draws itself when done, a slow breath while idle. SVG animation runs inside an image, so
// it needs nothing from the surface, but a redraw starts it again: each loop therefore begins in
// the past, at the point the clock has reached, and carries on across a redraw without a jump.
export type Motion = 'pulse' | 'spin' | 'draw' | 'breathe'

// A loop of `ms` begun so that it stands where it would had it run since the epoch, plus `offset`.
const phase = (ms: number, offset = 0) => `${(-(((Date.now() + offset) % ms) / 1000)).toFixed(3)}s`

const halo = (color: string, offset: number) =>
  `<circle cx="28" cy="28" r="18" fill="none" stroke="${color}" stroke-width="2" opacity="0"><animate attributeName="r" values="18;27" dur="1.8s" begin="${phase(1800, offset)}" repeatCount="indefinite"/><animate attributeName="opacity" values="0.6;0" dur="1.8s" begin="${phase(1800, offset)}" repeatCount="indefinite"/></circle>`

const MOTION: Record<Motion, (color: string) => string> = {
  pulse: color => halo(color, 0) + halo(color, 900),
  spin: color =>
    `<circle cx="28" cy="28" r="21" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-dasharray="34 98"><animateTransform attributeName="transform" type="rotate" from="0 28 28" to="360 28 28" dur="1.1s" begin="${phase(1100)}" repeatCount="indefinite"/></circle>`,
  draw: color => `<circle cx="28" cy="28" r="21" fill="none" stroke="${tint(color, '66')}" stroke-width="1.5"/>`,
  breathe: () => '',
}

// The badge at the left of the card: the glyph on a soft gradient disc of its color, moving. A check
// draws itself once, from `since`, when the card took its state; a later redraw shows it drawn.
export const badgeSvg = (glyph: Glyph, color: string, motion: Motion, since: number) => {
  const body =
    motion === 'draw' && glyph === 'check'
      ? `<path d="M5 12.5l4.5 4.5L19 7.5" stroke-dasharray="24" stroke-dashoffset="24"><animate attributeName="stroke-dashoffset" from="24" to="0" dur="0.6s" begin="${((150 - (Date.now() - since)) / 1000).toFixed(3)}s" fill="freeze"/></path>`
      : GLYPHS[glyph]
  const breath =
    motion === 'breathe' ? `<animate attributeName="opacity" values="1;0.5;1" dur="3.2s" begin="${phase(3200)}" repeatCount="indefinite"/>` : ''

  return `<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56" viewBox="0 0 56 56" fill="none" stroke-linecap="round" stroke-linejoin="round"><defs><radialGradient id="g" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="${color}" stop-opacity="0.45"/><stop offset="1" stop-color="${color}" stop-opacity="0.12"/></radialGradient></defs>${MOTION[motion](color)}<circle cx="28" cy="28" r="18" fill="url(#g)"/><circle cx="28" cy="28" r="17.5" stroke="${tint(color, '59')}"/><g transform="translate(18 18) scale(0.8333)" stroke="${color}" stroke-width="2.2">${body}${breath}</g></svg>`
}

// A band of light sweeping across a row Claude is working on. Stretched to the row by
// preserveAspectRatio="none" and clipped to its rounded corners.
export const shimmerSvg = (color: string, width: number, height: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 100 10" preserveAspectRatio="none"><defs><linearGradient id="s" x1="0" x2="1"><stop offset="0" stop-color="${color}" stop-opacity="0"/><stop offset="0.5" stop-color="${color}" stop-opacity="0.3"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient></defs><rect x="-35" y="0" width="35" height="10" fill="url(#s)"><animate attributeName="x" values="-35;100" dur="1.6s" begin="${phase(1600)}" repeatCount="indefinite"/></rect></svg>`

// A small dot: pulsing while live, still otherwise.
export const dotSvg = (color: string, isLive: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">${
    isLive
      ? `<circle cx="6" cy="6" r="3" fill="${color}" opacity="0"><animate attributeName="r" values="3;6" dur="1.4s" begin="${phase(1400)}" repeatCount="indefinite"/><animate attributeName="opacity" values="0.5;0" dur="1.4s" begin="${phase(1400)}" repeatCount="indefinite"/></circle>`
      : ''
  }<circle cx="6" cy="6" r="3" fill="${color}"/></svg>`

// A folder's chevron, closed and open: a thin stroke as in VS Code, turned down when open; the
// terminal draws a glyph instead.
export const chevronSvg = (isOpen: boolean) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"><path d="M4.5 2.75L7.75 6L4.5 9.25" fill="none" stroke="${MUTED}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" transform="rotate(${isOpen ? 90 : 0} 6 6)"/></svg>`
export const BLANK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12"/>'
// A menu's divider: a hairline as wide as the menu lets it be, its own width far past any menu's.
export const RULE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1" viewBox="0 0 1000 1" preserveAspectRatio="none"><rect width="1000" height="1" fill="${CARD_EDGE}"/></svg>`
export const CARETS = ['▸', '▾'] as const
