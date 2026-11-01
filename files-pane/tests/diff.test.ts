import { expect, test } from 'claude-code/testing'

import { rowsOf } from '../hooks/diff'
import { DELETED_FILE, LAST_LINE_WITHOUT_NEWLINE, LOGGED_RETRY, LOGGED_RETRY_AND_SLOWER_DELAY, NEW_FILE, RACE_IN_MAKEFILE } from './git-diffs'

// The text of each row, a hunk's as `@@`, to read how a diff's lines are drawn.
const texts = (text: string) => rowsOf(text).map(row => (row.kind === 'hunk' ? '@@' : row.text))

test('a diff numbers a line where it is now and a removed one where it was, under each hunk’s line and function', () => {
  // git's file header and the newline it ends on make no row.
  expect(rowsOf(LOGGED_RETRY_AND_SLOWER_DELAY)).toEqual([
    { kind: 'hunk', line: 5, context: 'export function retry(fn, times) {' },
    { kind: 'same', line: 5, text: '    } catch (error) {' },
    { kind: 'same', line: 6, text: '      if (i === times - 1) throw error' },
    { kind: 'add', line: 7, text: '      log(error)' },
    { kind: 'same', line: 8, text: '    }' },
    { kind: 'same', line: 9, text: '  }' },
    { kind: 'hunk', line: 12, context: 'export function retry(fn, times) {' },
    { kind: 'same', line: 12, text: 'export function delay(ms) {' },
    { kind: 'same', line: 13, text: '  return new Promise(resolve => {' },
    { kind: 'del', line: 13, text: '    setTimeout(resolve, ms)' },
    { kind: 'add', line: 14, text: '    setTimeout(resolve, ms * 2)' },
    { kind: 'same', line: 15, text: '  })' },
    { kind: 'same', line: 16, text: '}' },
  ])
})

test('the indent every line of a diff shares is taken off, so the change starts at the row’s left', () => {
  expect(texts(LOGGED_RETRY)).toEqual(['@@', '  } catch (error) {', '    if (i === times - 1) throw error', '    log(error)', '  }', '}'])
})

test('a tab reads as two spaces, and a blank line in the file stays a blank row', () => {
  expect(rowsOf(RACE_IN_MAKEFILE)).toEqual([
    { kind: 'hunk', line: 3, context: 'build:' },
    { kind: 'same', line: 3, text: '' },
    { kind: 'same', line: 4, text: 'test:' },
    { kind: 'del', line: 5, text: '  go test ./...' },
    { kind: 'add', line: 5, text: '  go test -race ./...' },
  ])
})

test('a last line with no newline is drawn once a side, without git’s note', () => {
  expect(rowsOf(LAST_LINE_WITHOUT_NEWLINE)).toEqual([
    { kind: 'hunk', line: 1, context: '' },
    { kind: 'same', line: 1, text: 'first' },
    { kind: 'del', line: 2, text: 'last' },
    { kind: 'add', line: 2, text: 'last!' },
  ])
})

test('a new file numbers its lines from 1, and a deleted one keeps the numbers its lines had', () => {
  expect(rowsOf(NEW_FILE)).toEqual([
    { kind: 'hunk', line: 1, context: '' },
    { kind: 'add', line: 1, text: 'hello' },
    { kind: 'add', line: 2, text: 'world' },
  ])
  expect(rowsOf(DELETED_FILE)).toEqual([
    { kind: 'hunk', line: 1, context: '' },
    { kind: 'del', line: 1, text: 'one' },
    { kind: 'del', line: 2, text: 'two' },
  ])
})

test('an empty diff is no rows', () => {
  expect(rowsOf('')).toEqual([])
})
