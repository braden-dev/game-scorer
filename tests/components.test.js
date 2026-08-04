import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { fromRemoteRows } from '../src/lib/cloudState.js'

const fakeReact = `
export const Fragment = Symbol.for('fragment')
export function jsx(type, props, key) { return { type, props: { ...(props ?? {}), key } } }
export const jsxs = jsx
export function useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] }
export function useEffect() {}
export function useMemo(factory) { return factory() }
`

async function loadPeople() {
  const plugin = {
    name: 'scorebook-people-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/router\.js$/ }, () => ({ path: 'router', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: path === 'router'
          ? 'export function navigate(route) { globalThis.__peopleRoute = route }'
          : fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/People.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

async function loadMigrationPanel() {
  const plugin = {
    name: 'scorebook-migration-panel-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, () => ({
        contents: fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/MigrationPanel.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

async function loadGameView() {
  const plugin = {
    name: 'scorebook-game-view-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/useWakeLock\.js$/ }, () => ({ path: 'wakeLock', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: path === 'wakeLock' ? 'export function useWakeLock() {}' : fakeReact,
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/components/GameView.jsx'],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  return (await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`)).default
}

function childrenOf(element) {
  const children = element?.props?.children
  return Array.isArray(children) ? children : [children]
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  for (const child of childrenOf(element)) {
    const match = findElement(child, predicate)
    if (match) return match
  }
  return null
}

function textOf(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  return childrenOf(element).map(textOf).join(' ')
}

test('People shows active roster stats and opens a person page', async () => {
  const People = await loadPeople()
  const tree = People({
    roster: [
      { id: 'p_john', name: 'John' },
      { id: 'p_deleted', name: 'Deleted', deletedAt: 123 },
    ],
    games: [{
      id: 'g_one',
      gameId: 'farkle',
      players: [{ id: 'p_john', name: 'John' }, { id: 'p_other', name: 'Other' }],
      settings: { target: 100, opening: 0, straight: 1500, threePairs: 1500, twoTriplets: 2500, multiRule: 'fixed' },
      rounds: [{ entries: { p_john: { score: 100 }, p_other: { score: 50 } } }],
    }],
  })

  assert.match(textOf(tree), /John/)
  assert.match(textOf(tree), /1\s+game/)
  assert.match(textOf(tree), /1\s+win/)
  assert.doesNotMatch(textOf(tree), /Deleted/)

  const personButton = findElement(tree, (element) => element.type === 'button' && element.props?.className === 'directory-open')
  assert.ok(personButton)
  personButton.props.onClick()
  assert.deepEqual(globalThis.__peopleRoute, { type: 'person', id: 'p_john' })
})

test('MigrationPanel reports skipped unsupported games before publish', async () => {
  const MigrationPanel = await loadMigrationPanel()
  const tree = MigrationPanel({
    state: {
      roster: [{ id: 'p_roster', name: 'Roster Player' }],
      games: [{
        id: 'g_supported', gameId: 'farkle', players: [], rounds: [], settings: {},
      }, {
        id: 'g_future', gameId: 'future-game', players: [], rounds: [], settings: {},
      }],
    },
    onPublish: () => {},
    onKeepLocal: () => {},
  })

  const notice = findElement(tree, (element) => element.props?.role === 'status')
  assert.ok(notice)
  assert.match(textOf(notice), /Skipping\s+1\s+unsupported\s+game/)
})

test('GameView safely renders malformed remote settings with defaults', async () => {
  const GameView = await loadGameView()
  const baseGame = {
    id: 'g_malformed_settings',
    gameId: 'farkle',
    players: [{ id: 'p_one', name: 'One' }, { id: 'p_two', name: 'Two' }],
    rounds: [],
    finishedAt: null,
  }

  for (const target of ['not-a-number', {}, null, Number.NaN]) {
    assert.doesNotThrow(() => {
      const tree = GameView({
        game: { ...baseGame, settings: { target } },
        roster: baseGame.players,
        onUpdate: () => {},
        onBack: () => {},
        onRematch: () => {},
        onAddToRoster: () => baseGame.players[0],
      })
      assert.match(textOf(tree), /first to 10,000/)
    }, `target=${String(target)}`)
  }
})

test('GameView safely renders a cloud snapshot with malformed nested Dutch Blitz entries', async () => {
  const GameView = await loadGameView()
  const state = fromRemoteRows({
    people: [
      { id: 'p_bad', name: 'Bad' },
      { id: 'p_good', name: 'Good' },
    ],
    games: [
      { id: 'g_bad', game_id: 'dutch-blitz', settings: { target: 10, blitzPenalty: 2 } },
      { id: 'g_good', game_id: 'dutch-blitz', settings: { target: 10, blitzPenalty: 2 } },
    ],
    gamePlayers: [
      { game_id: 'g_bad', person_id: 'p_bad', seat_order: 0, name_snapshot: 'Bad' },
      { game_id: 'g_good', person_id: 'p_good', seat_order: 0, name_snapshot: 'Good' },
    ],
    rounds: [
      { id: 'r_bad', game_id: 'g_bad', round_index: 0, entries: { p_bad: null } },
      { id: 'r_good', game_id: 'g_good', round_index: 0, entries: { p_good: { dutch: 10, blitz: 0, blitzed: false } } },
    ],
  })

  assert.deepEqual(state.games.find(({ id }) => id === 'g_bad').rounds, [])
  for (const game of state.games) {
    assert.doesNotThrow(() => GameView({
      game,
      roster: state.roster,
      onUpdate: () => {},
      onBack: () => {},
      onRematch: () => {},
      onAddToRoster: () => ({ id: 'p_new', name: 'New' }),
    }))
  }
})

test('GameView lists every tied rank-one winner in the winner banner', async () => {
  const GameView = await loadGameView()
  const tree = GameView({
    game: {
      id: 'g_tied_winners',
      gameId: 'farkle',
      players: [
        { id: 'p_one', name: 'One' },
        { id: 'p_two', name: 'Two' },
        { id: 'p_three', name: 'Three' },
      ],
      settings: { target: 100, opening: 0 },
      rounds: [{ entries: {
        p_one: { score: 100 },
        p_two: { score: 100 },
        p_three: { score: 50 },
      } }],
      finishedAt: null,
    },
    roster: [],
    onUpdate: () => {},
    onBack: () => {},
    onRematch: () => {},
    onAddToRoster: () => ({ id: 'p_new', name: 'New' }),
  })

  const banner = findElement(tree, (element) => element.props?.className === 'winner-banner')
  assert.match(textOf(banner), /One and Two win!/)
})
