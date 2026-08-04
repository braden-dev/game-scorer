import { accessSync, constants as fsConstants } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, delimiter, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const repoRoot = resolve(dirname(scriptPath), '..')
const migrationPath = resolve(repoRoot, 'supabase/migrations/20260804000100_create_scorebook.sql')
const linkedProjectRefPath = resolve(repoRoot, 'supabase/.temp/project-ref')

function findExecutable(name) {
  const candidates = [
    resolve(repoRoot, 'node_modules/.bin', name),
    ...(process.env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, name)),
  ]
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, fsConstants.X_OK)
      return true
    } catch {
      return false
    }
  }) ?? null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    ...options,
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error,
  }
}

function assertMigrationShape(migration) {
  if (/unique\s*\(\s*game_id\s*,\s*round_index\s*\)/i.test(migration)) {
    throw new Error('migration still contains an unconditional rounds position constraint')
  }
  if (!/drop\s+constraint\s+if\s+exists\s+rounds_game_id_round_index_key/i.test(migration)) {
    throw new Error('migration does not remove the legacy rounds position constraint safely')
  }
  if (!/create\s+unique\s+index\s+if\s+not\s+exists\s+rounds_live_game_round_index_idx[\s\S]*?where\s+deleted_at\s+is\s+null/i.test(migration)) {
    throw new Error('migration does not define the live-round partial unique index')
  }
}

function escapeSqlLiteral(value) {
  return value.replaceAll("'", "''")
}

function localValidationSql(migration, suffix) {
  const gameId = `migration_validation_game_${suffix}`
  const tombstoneRoundId = `migration_validation_tombstone_${suffix}`
  const liveRoundId = `migration_validation_live_${suffix}`
  const duplicateRoundId = `migration_validation_duplicate_${suffix}`
  const migrationSql = `${migration}\n${migration}`

  return `BEGIN;
-- Run the migration twice in one transaction to prove rerun safety.
${migrationSql}

insert into public.games (id, game_id, settings)
values ('${escapeSqlLiteral(gameId)}', 'farkle', '{}'::jsonb);

-- A deleted tombstone may retain an index now reused by a shifted live row.
insert into public.rounds (id, game_id, round_index, entries, deleted_at)
values ('${escapeSqlLiteral(tombstoneRoundId)}', '${escapeSqlLiteral(gameId)}', 0, '{}'::jsonb, now());
insert into public.rounds (id, game_id, round_index, entries)
values ('${escapeSqlLiteral(liveRoundId)}', '${escapeSqlLiteral(gameId)}', 0, '{}'::jsonb);

do $$
declare
  duplicate_rejected boolean := false;
begin
  begin
    insert into public.rounds (id, game_id, round_index, entries)
    values ('${escapeSqlLiteral(duplicateRoundId)}', '${escapeSqlLiteral(gameId)}', 0, '{}'::jsonb);
  exception when unique_violation then
    duplicate_rejected := true;
  end;
  if not duplicate_rejected then
    raise exception 'live round position uniqueness was not enforced';
  end if;
end $$;

-- Never apply this validation fixture, even when a caller supplies a database URL.
ROLLBACK;
`
}

function validateLinkedLint() {
  if (!findExecutable('supabase')) {
    console.log('SKIP: Supabase CLI is unavailable; linked db lint was not run.')
    return
  }
  try {
    accessSync(linkedProjectRefPath, fsConstants.F_OK)
  } catch {
    console.log('SKIP: no linked Supabase project is configured; linked db lint was not run.')
    return
  }

  const cli = findExecutable('supabase')
  const result = run(cli, ['db', 'lint', '--linked'])
  if (result.status === 0) {
    console.log('PASS: supabase db lint --linked')
    return
  }

  const details = `${result.error?.message ?? ''}\n${result.stdout}\n${result.stderr}`.toLowerCase()
  if (/telemetry|read-only file system|erofs|not logged in|access token|not linked|command not found/.test(details)) {
    console.log('SKIP: linked Supabase lint is unavailable in this environment.')
    return
  }
  throw new Error(`supabase db lint --linked failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`)
}

function detectLocalDatabase() {
  if (process.env.MIGRATION_TEST_DATABASE_URL) return process.env.MIGRATION_TEST_DATABASE_URL

  const pgIsReady = findExecutable('pg_isready')
  if (!pgIsReady) return null
  const result = run(pgIsReady, ['-q', '-h', '127.0.0.1', '-p', '54322'])
  if (result.status === 0) return 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
  return null
}

async function validateLocalSql(migration) {
  const psql = findExecutable('psql')
  if (!psql) {
    console.log('SKIP: psql is unavailable; executable local migration validation was not run.')
    return
  }

  const databaseUrl = detectLocalDatabase()
  if (!databaseUrl) {
    console.log('SKIP: no local Postgres validation database is available; set MIGRATION_TEST_DATABASE_URL to a disposable local database to run it.')
    return
  }

  const tempDirectory = await mkdtemp(join(tmpdir(), 'game-scorer-migration-'))
  const sqlPath = join(tempDirectory, 'validate.sql')
  try {
    await writeFile(sqlPath, localValidationSql(migration, `${process.pid}_${Date.now()}`), 'utf8')
    const result = run(psql, ['--dbname', databaseUrl, '--no-psqlrc', '--set', 'ON_ERROR_STOP=1', '--file', sqlPath])
    if (result.status !== 0) {
      throw new Error(`local Postgres migration validation failed: ${result.stderr || result.stdout || result.error?.message || 'unknown error'}`)
    }
    console.log('PASS: local Postgres executed the migration twice and verified live/tombstone round-index behavior (rolled back)')
  } finally {
    await rm(tempDirectory, { recursive: true, force: true })
  }
}

try {
  const migration = await readFile(migrationPath, 'utf8')
  assertMigrationShape(migration)
  console.log('Migration SQL validation')
  validateLinkedLint()
  await validateLocalSql(migration)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
