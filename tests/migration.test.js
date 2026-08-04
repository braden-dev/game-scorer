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
const timestampMigrationPath = path.resolve(
  path.dirname(migrationPath),
  '20260804000200_preserve_explicit_updated_at.sql',
)
const monotonicTimestampMigrationPath = path.resolve(
  path.dirname(migrationPath),
  '20260804000300_monotonic_updated_at_trigger.sql',
)
const migrationWorkflowPath = path.resolve(
  path.dirname(migrationPath),
  '../../.github/workflows/migration-validation.yml',
)
const deployWorkflowPath = path.resolve(
  path.dirname(migrationPath),
  '../../.github/workflows/deploy.yml',
)

function assertLiveRoundPositions(rows) {
  const liveKeys = rows
    .filter((row) => row.deleted_at === null)
    .map((row) => `${row.game_id}:${row.round_index}`)
  assert.equal(new Set(liveKeys).size, liveKeys.length, 'duplicate live round position')
}

test('name constraints measure the trimmed value for people and player snapshots', () => {
  assert.match(
    migration,
    /name\s+text\s+not\s+null\s+check\s*\(\s*char_length\(btrim\(name\)\)\s+between\s+1\s+and\s+80\s*\)/i,
  )
  assert.match(
    migration,
    /name_snapshot\s+text\s+not\s+null\s+check\s*\(\s*char_length\(btrim\(name_snapshot\)\)\s+between\s+1\s+and\s+80\s*\)/i,
  )
})

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

test('migration validation command includes linked lint and transactional local SQL checks', () => {
  const validationScript = fs.readFileSync(
    path.resolve(path.dirname(migrationPath), '../../scripts/validate-migration.mjs'),
    'utf8',
  )
  const migrationFiles = fs.readdirSync(path.dirname(migrationPath))
    .filter((file) => file.endsWith('.sql'))

  assert.match(validationScript, /\['db', 'lint', '--linked'\]/)
  for (const migrationFile of migrationFiles) {
    assert.match(validationScript, new RegExp(migrationFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.match(validationScript, /Run the migration twice in one transaction/)
  assert.match(validationScript, /ROLLBACK;/)
  assert.match(validationScript, /live\/tombstone round-index behavior/)
  assert.match(validationScript, /explicit application timestamp/)
  assert.match(validationScript, /monotonic|regress/i)
})

test('follow-up timestamp migration preserves explicit application versions and is rerun-safe', () => {
  const timestampMigration = fs.readFileSync(timestampMigrationPath, 'utf8')
  assert.match(timestampMigration, /create\s+or\s+replace\s+function\s+public\.set_updated_at\s*\(\)/i)
  assert.match(timestampMigration, /if\s+new\.updated_at\s+is\s+null\s+or\s+new\.updated_at\s*=\s+old\.updated_at/i)
  assert.match(timestampMigration, /new\.updated_at\s*=\s+now\(\)/i)
  assert.equal((timestampMigration.match(/create\s+or\s+replace\s+function/gi) ?? []).length, 1)
})

test('latest timestamp migration prevents regressions while preserving newer explicit versions', () => {
  const timestampMigration = fs.readFileSync(monotonicTimestampMigrationPath, 'utf8')
  assert.match(timestampMigration, /create\s+or\s+replace\s+function\s+public\.set_updated_at\s*\(\)/i)
  assert.match(timestampMigration, /if\s+new\.updated_at\s+is\s+null\s+or\s+new\.updated_at\s*<=\s*old\.updated_at/i)
  assert.match(timestampMigration, /new\.updated_at\s*=\s*greatest\s*\(\s*now\(\)\s*,\s*old\.updated_at\s*\+\s*interval\s+'1\s+microsecond'\s*\)/i)
  assert.match(timestampMigration, /end\s+if\s*;/i)
  assert.equal((timestampMigration.match(/create\s+or\s+replace\s+function/gi) ?? []).length, 1)
})

test('migration validation workflow provisions Postgres and runs executable SQL checks', () => {
  const workflow = fs.readFileSync(migrationWorkflowPath, 'utf8')
  assert.match(workflow, /services:\s*[\s\S]*postgres:/i)
  assert.match(workflow, /MIGRATION_TEST_DATABASE_URL:\s*postgresql:\/\/postgres:postgres@127\.0\.0\.1:54322\/postgres/i)
  assert.match(workflow, /command\s+-v\s+psql[\s\S]*postgresql-client/i)
  assert.match(workflow, /create\s+role\s+anon/i)
  assert.match(workflow, /create\s+role\s+authenticated/i)
  const normalizedWorkflow = workflow.toLowerCase()
  assert.ok(normalizedWorkflow.indexOf('create role anon') < normalizedWorkflow.indexOf('npm run validate:migration'))
  assert.match(workflow, /npm run validate:migration/)
})

test('Pages deployment is gated by one verified production artifact', () => {
  const workflow = fs.readFileSync(deployWorkflowPath, 'utf8')
  assert.match(workflow, /jobs:\s*\n\s+verify:/)
  assert.match(workflow, /verify:[\s\S]*?npm test[\s\S]*?npm run build[\s\S]*?npm run assert:build[\s\S]*?npm run validate:migration/)
  assert.match(workflow, /verify:[\s\S]*?services:\s*\n\s+postgres:/)
  assert.match(workflow, /verify:[\s\S]*?create role anon/)
  assert.match(workflow, /verify:[\s\S]*?create role authenticated/)
  assert.match(workflow, /build:\s*\n\s+needs:\s+verify/)
  assert.match(workflow, /build:[\s\S]*?download-artifact@v4[\s\S]*?upload-pages-artifact@v3/)
  assert.match(workflow, /deploy:\s*\n\s+needs:\s+build/)
  assert.equal((workflow.match(/VITE_SUPABASE_URL/g) ?? []).length, 3)
  assert.equal((workflow.match(/VITE_SUPABASE_PUBLISHABLE_KEY/g) ?? []).length, 3)
  assert.doesNotMatch(workflow, /secrets\./)
})
