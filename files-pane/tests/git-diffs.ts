// What git prints for a changed file, as diffOf asks it (`git diff --no-color --no-ext-diff -U2`,
// with `--no-index -- /dev/null <file>` for a file git does not track yet), copied from real runs.
// Each is a line per string so a tab, a trailing space and git's final newline stay as git printed them.

const lines = (...all: string[]) => all.join('\n')

// src/client.js with `log(error)` added inside retry's catch: one hunk, every line indented.
export const LOGGED_RETRY = lines(
  'diff --git a/src/client.js b/src/client.js',
  'index 2527224..14eff86 100644',
  '--- a/src/client.js',
  '+++ b/src/client.js',
  '@@ -5,4 +5,5 @@ export function retry(fn, times) {',
  '     } catch (error) {',
  '       if (i === times - 1) throw error',
  '+      log(error)',
  '     }',
  '   }',
  '',
)

// The same file with delay's timeout doubled too: a second hunk, which starts at a line with no indent.
export const LOGGED_RETRY_AND_SLOWER_DELAY = lines(
  'diff --git a/src/client.js b/src/client.js',
  'index 2527224..90af1d9 100644',
  '--- a/src/client.js',
  '+++ b/src/client.js',
  '@@ -5,4 +5,5 @@ export function retry(fn, times) {',
  '     } catch (error) {',
  '       if (i === times - 1) throw error',
  '+      log(error)',
  '     }',
  '   }',
  '@@ -11,5 +12,5 @@ export function retry(fn, times) {',
  ' export function delay(ms) {',
  '   return new Promise(resolve => {',
  '-    setTimeout(resolve, ms)',
  '+    setTimeout(resolve, ms * 2)',
  '   })',
  ' }',
  '',
)

// A Makefile's test target given `-race`: its recipe indented with a tab, a blank line above it.
export const RACE_IN_MAKEFILE = lines(
  'diff --git a/Makefile b/Makefile',
  'index d5476e5..e1ae220 100644',
  '--- a/Makefile',
  '+++ b/Makefile',
  '@@ -3,3 +3,3 @@ build:',
  ' ',
  ' test:',
  '-\tgo test ./...',
  '+\tgo test -race ./...',
  '',
)

// A file that ends without a newline, its last line changed: git notes it after both sides.
export const LAST_LINE_WITHOUT_NEWLINE = lines(
  'diff --git a/notes.txt b/notes.txt',
  'index 3db2aff..01dd116 100644',
  '--- a/notes.txt',
  '+++ b/notes.txt',
  '@@ -1,2 +1,2 @@',
  ' first',
  '-last',
  '\\ No newline at end of file',
  '+last!',
  '\\ No newline at end of file',
  '',
)

// A file git does not track yet, against /dev/null.
export const NEW_FILE = lines(
  'diff --git a/new.txt b/new.txt',
  'new file mode 100644',
  'index 0000000..94954ab',
  '--- /dev/null',
  '+++ b/new.txt',
  '@@ -0,0 +1,2 @@',
  '+hello',
  '+world',
  '',
)

// A tracked file deleted from the working tree.
export const DELETED_FILE = lines(
  'diff --git a/old.txt b/old.txt',
  'deleted file mode 100644',
  'index 814f4a4..0000000',
  '--- a/old.txt',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-one',
  '-two',
  '',
)
