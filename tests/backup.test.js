import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { parseBackup, mergeBackup } from '../src/lib/backup.js'

const esbuildUrl = import.meta.resolve('esbuild')
const jsxLoader = `
  import { readFile } from 'node:fs/promises'
  import { transform } from '${esbuildUrl}'

  export async function load(url, context, nextLoad) {
    if (!url.endsWith('.jsx')) return nextLoad(url, context)
    const source = await readFile(new URL(url), 'utf8')
    const transformed = await transform(source, { loader: 'jsx', format: 'esm', sourcefile: url })
    return { format: 'module', source: transformed.code, shortCircuit: true }
  }
`

register(`data:text/javascript,${encodeURIComponent(jsxLoader)}`, import.meta.url)
const { evaluate } = await import('../src/games/index.js')

test('backup import keeps valid games and skips malformed nested records with a result', async () => {
  const validGame = {
    id: 'g_valid',
    gameId: 'farkle',
    settings: {},
    players: [{ id: 'p_valid', name: 'Valid' }],
    rounds: [{ id: 'r_valid', entries: { p_valid: { score: 100 } } }],
    finishedAt: null,
  }
  const backup = parseBackup(JSON.stringify({
    format: 'gamescorer-backup',
    version: 1,
    roster: [{ id: 'p_valid', name: 'Valid' }, null, { id: 'p_bad', name: 7 }],
    games: [
      validGame,
      { id: 'g_null_children', gameId: 'farkle', settings: {}, players: null, rounds: null },
      { id: 'g_bad_player', gameId: 'farkle', settings: {}, players: [{ id: 'p_bad', name: 'Bad', seatOrder: 'first' }], rounds: [] },
      { id: 'g_bad_settings', gameId: 'farkle', settings: { target: '100' }, players: [], rounds: [] },
      { id: 'g_bad_round', gameId: 'farkle', settings: {}, players: [{ id: 'p_valid', name: 'Valid' }], rounds: [{ id: 'r_bad', entries: null }] },
    ],
  }))

  const merged = mergeBackup({ games: [], roster: [] }, backup)

  assert.deepEqual(merged.state.games.map(({ id }) => id), ['g_valid'])
  assert.deepEqual(merged.state.roster.map(({ id }) => id), ['p_valid'])
  assert.equal(merged.skipped.invalidGames, 4)
  assert.equal(merged.skipped.invalidPlayers, 2)
  assert.equal(merged.state.games[0].rounds[0].entries.p_valid.score, 100)
  assert.doesNotThrow(() => evaluate(merged.state.games[0]))
})
