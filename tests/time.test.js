import test from 'node:test'
import assert from 'node:assert/strict'
import { compareUpdatedAt } from '../src/lib/time.js'
import { relativeDate } from '../src/lib/util.js'

test('compareUpdatedAt parses ISO timestamps and gives equal timestamps a stable ID order', () => {
  const games = [
    { id: 'game-z', updatedAt: '2026-08-04T12:00:00.000Z' },
    { id: 'game-a', updatedAt: '2026-08-04T12:00:00.000Z' },
    { id: 'game-old', updatedAt: '2026-08-03T12:00:00.000Z' },
  ]

  assert.deepEqual(games.slice().sort(compareUpdatedAt).map((game) => game.id), ['game-a', 'game-z', 'game-old'])
  assert.deepEqual(games.slice().reverse().sort(compareUpdatedAt).map((game) => game.id), ['game-a', 'game-z', 'game-old'])
})

test('relativeDate safely formats strings and unknown timestamps', () => {
  assert.doesNotMatch(relativeDate('2026-08-04T12:00:00.000Z'), /NaN|Invalid/)
  assert.equal(relativeDate('not-a-timestamp'), 'unknown time')
})
