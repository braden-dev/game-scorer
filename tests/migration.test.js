import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../supabase/migrations/20260804000100_create_scorebook.sql',
)
const migration = fs.readFileSync(migrationPath, 'utf8')

function assertLiveRoundPositions(rows) {
  const liveKeys = rows
    .filter((row) => row.deleted_at === null)
    .map((row) => `${row.game_id}:${row.round_index}`)
  assert.equal(new Set(liveKeys).size, liveKeys.length, 'duplicate live round position')
}

test('round position uniqueness excludes tombstones but rejects duplicate live rows', () => {
  assert.doesNotMatch(migration, /unique\s*\(\s*game_id\s*,\s*round_index\s*\)/i)
  assert.match(
    migration,
    /alter\s+table\s+public\.rounds\s+drop\s+constraint\s+if\s+exists\s+rounds_game_id_round_index_key\s*;/i,
  )
  assert.match(
    migration,
    /create\s+unique\s+index\s+if\s+not\s+exists\s+rounds_live_game_round_index_idx\s+on\s+public\.rounds\s*\(\s*game_id\s*,\s*round_index\s*\)\s+where\s+deleted_at\s+is\s+null\s*;/i,
  )

  const shiftedRoundRows = [
    { id: 'r_deleted', game_id: 'g_one', round_index: 0, deleted_at: '2026-08-04T00:00:00.000Z' },
    { id: 'r_shifted', game_id: 'g_one', round_index: 0, deleted_at: null },
  ]
  assert.doesNotThrow(() => assertLiveRoundPositions(shiftedRoundRows))
  assert.throws(
    () => assertLiveRoundPositions([
      ...shiftedRoundRows,
      { id: 'r_duplicate', game_id: 'g_one', round_index: 0, deleted_at: null },
    ]),
    /duplicate live round position/,
  )
})
