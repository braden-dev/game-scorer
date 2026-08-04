import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { toRemoteRows } from '../src/lib/cloudState.js'
import { enqueueMutation, loadSyncStore } from '../src/lib/sync.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
}

const fakeReact = `
const state = globalThis.__scorebookTestReactState ??= { slots: [], cursor: 0 }
globalThis.__scorebookTestReact = globalThis.__scorebookTestReact ?? {
  begin() { state.cursor = 0 },
  reset() { state.slots = []; state.cursor = 0 },
}
export const Fragment = Symbol.for('fragment')
export function jsx(type, props, key) { return { type, props: { ...(props ?? {}), key } } }
export const jsxs = jsx
export function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), ...(children.length ? { children: children.length === 1 ? children[0] : children } : {}) } }
}
export default { createElement, Fragment }
export function useState(initial) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = typeof initial === 'function' ? initial() : initial
  return [state.slots[index], (value) => {
    state.slots[index] = typeof value === 'function' ? value(state.slots[index]) : value
  }]
}
export function useRef(current) {
  const index = state.cursor++
  if (!(index in state.slots)) state.slots[index] = { current }
  return state.slots[index]
}
export function useEffect() {}
export function useCallback(fn) { return fn }
export function useMemo(factory) { return factory() }
`

const fakeReactWithEffects = fakeReact
  .replace(
    'const state = globalThis.__scorebookTestReactState ??= { slots: [], cursor: 0 }',
    `const state = globalThis.__scorebookTestReactState ??= { slots: [], cursor: 0 }
state.effectDeps ??= []
state.effectCleanups ??= []
state.pendingEffects ??= []`,
  )
  .replace(
    'reset() { state.slots = []; state.cursor = 0; }',
    'reset() { state.slots = []; state.cursor = 0; state.effectDeps = []; state.effectCleanups = []; state.pendingEffects = [] }',
  )
  .replace(
    'export function useEffect() {}',
    `export function useEffect(effect, dependencies) {
  const index = state.cursor++
  const previous = state.effectDeps[index]
  const changed = !dependencies
    || !previous
    || dependencies.length !== previous.length
    || dependencies.some((value, dependencyIndex) => value !== previous[dependencyIndex])
  state.effectDeps[index] = dependencies
  if (changed) state.pendingEffects.push({ index, effect })
}
globalThis.__scorebookTestReact.flushEffects = () => {
  for (const { index, effect } of state.pendingEffects.splice(0)) {
    state.effectCleanups[index]?.()
    const cleanup = effect()
    state.effectCleanups[index] = typeof cleanup === 'function' ? cleanup : null
  }
}`,
  )

const fakeSupabase = `
export const supabase = {}
export function cloudConfigured() { return true }
`

const fakeSync = `
const state = globalThis.__scorebookTestSync ??= { mutations: [] }
export const CONFLICT_MESSAGE = 'This was changed on another device. The shared version is now shown.'
export function useCloudSync() {
  return {
    status: 'synced',
    pendingCount: state.mutations.length,
    error: state.error ?? null,
    syncNow: async () => {},
    enqueueStateMutation(mutation) {
      state.mutations.push(mutation)
      return mutation
    },
    cancelSyncMutations(predicate) {
      state.mutations = state.mutations.filter((mutation) => !predicate?.(mutation))
    },
    updateSyncStore() {},
  }
}
`

const fakeWakeLock = 'export function useWakeLock() {}'

async function loadComponent(entryPoint, { realEffects = false } = {}) {
  const aliases = {
    react: realEffects ? fakeReactWithEffects : fakeReact,
    'react/jsx-runtime': realEffects ? fakeReactWithEffects : fakeReact,
    supabase: fakeSupabase,
    sync: fakeSync,
    wakeLock: fakeWakeLock,
  }
  const plugin = {
    name: 'scorebook-component-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\/lib\/supabase\.js$/ }, () => ({ path: 'supabase', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\/lib\/useCloudSync\.js$/ }, () => ({ path: 'sync', namespace: 'scorebook-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/useWakeLock\.js$/ }, () => ({ path: 'wakeLock', namespace: 'scorebook-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-test' }, ({ path }) => ({
        contents: aliases[path],
        loader: 'js',
      }))
    },
  }
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    jsx: 'automatic',
    platform: 'node',
    plugins: [plugin],
    write: false,
  })
  const code = result.outputFiles[0].text
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default
}

function childrenOf(element) {
  const children = element?.props?.children
  return Array.isArray(children) ? children : [children]
}

function findElement(element, predicate) {
  if (!element || typeof element !== 'object') return null
  if (predicate(element)) return element
  const children = element.type?.name === 'AppShell'
    ? [element.props.content, element.props.undoToast, element.props.syncNotice]
    : childrenOf(element)
  for (const child of children) {
    const match = findElement(child, predicate)
    if (match) return match
  }
  return null
}

function appContent(appTree) {
  return appTree?.type?.name === 'AppShell' ? appTree.props.content : appTree
}

function textOf(element) {
  if (element === null || element === undefined || typeof element === 'boolean') return ''
  if (typeof element === 'string' || typeof element === 'number') return String(element)
  return childrenOf(element).map(textOf).join(' ')
}

function gameState() {
  return {
    activeGameId: 'g_mutations',
    roster: [{ id: 'p_one', name: 'One' }, { id: 'p_two', name: 'Two' }],
    games: [{
      id: 'g_mutations',
      gameId: 'farkle',
      createdAt: 100,
      updatedAt: 200,
      players: [{ id: 'p_one', name: 'One' }, { id: 'p_two', name: 'Two' }],
      settings: {
        target: 10000,
        opening: 500,
        straight: 1500,
        threePairs: 1500,
        twoTriplets: 2500,
        multiRule: 'fixed',
      },
      rounds: [{
        id: 'r_removed',
        entries: { p_one: { score: 500 }, p_two: { score: 700 } },
      }],
      finishedAt: null,
    }],
  }
}

function prepareStorage(state) {
  const storage = new MemoryStorage()
  storage.setItem('gamescorer.v1', JSON.stringify(state))
  globalThis.localStorage = storage
  globalThis.window = {
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    confirm: () => true,
    addEventListener() {},
    removeEventListener() {},
  }
  return storage
}

function resetTestState() {
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestSync.mutations = []
  globalThis.__scorebookTestSync.error = null
}

test('App round deletion queues the updated game before the round tombstone', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  assert.equal(appContent(appTree).type.name, 'GameView')

  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  let gameTree = appContent(appTree).type(appContent(appTree).props)
  const historyRow = findElement(gameTree, (element) => element.type === 'tr' && element.props?.onClick)
  assert.ok(historyRow)
  historyRow.props.onClick()

  globalThis.__scorebookTestReact.begin()
  gameTree = appContent(appTree).type(appContent(appTree).props)
  const roundSheet = findElement(gameTree, (element) => element.props?.onDelete)
  assert.ok(roundSheet)
  roundSheet.props.onDelete()

  const mutations = globalThis.__scorebookTestSync.mutations
  assert.deepEqual(mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'scorebook', operation: 'upsert' },
    { entity: 'rounds', operation: 'softDelete' },
  ])
  assert.equal(mutations[0].payload.rows.games[0].id, 'g_mutations')
  assert.equal(mutations[0].payload.rows.games[0].finished_at, null)
  assert.deepEqual(mutations[1].payload, {
    gameId: 'g_mutations',
    roundIndex: 0,
    entries: { p_one: { score: 500 }, p_two: { score: 700 } },
  })
})

test('round deletion asks for confirmation and explains the brief Undo window', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  const confirmations = []
  globalThis.window.confirm = (message) => {
    confirmations.push(message)
    return false
  }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  let gameTree = appContent(appTree).type(appContent(appTree).props)
  const historyRow = findElement(gameTree, (element) => element.type === 'tr' && element.props?.onClick)
  assert.ok(historyRow)
  historyRow.props.onClick()

  globalThis.__scorebookTestReact.begin()
  gameTree = appContent(appTree).type(appContent(appTree).props)
  const roundSheet = findElement(gameTree, (element) => element.props?.onDelete)
  assert.ok(roundSheet)
  roundSheet.props.onDelete()

  assert.deepEqual(confirmations, ['Delete this turn? Undo is available for 10 seconds.'])
  assert.deepEqual(globalThis.__scorebookTestSync.mutations, [])
})

test('game deletion can be undone before the ten-second window expires', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.activeGameId = null
  prepareStorage(state)
  const confirmations = []
  globalThis.window.confirm = (message) => {
    confirmations.push(message)
    return true
  }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  const homeElement = appContent(appTree).props.children[0]
  const homeTree = homeElement.type(homeElement.props)
  const gameCard = findElement(homeTree, (element) => element.type?.name === 'GameCard')
  assert.ok(gameCard)
  const deleteButton = findElement(gameCard.type(gameCard.props), (element) => element.props?.['aria-label'] === 'Delete Farkle game')
  assert.ok(deleteButton)
  deleteButton.props.onClick()
  assert.deepEqual(confirmations, ['Delete this Farkle game? Undo is available for 10 seconds.'])

  globalThis.__scorebookTestReact.begin()
  const appAfterDelete = App()
  const deletedHomeElement = appContent(appAfterDelete).props.children[0]
  let renderedHome = deletedHomeElement.type(deletedHomeElement.props)
  const toastElement = findElement(appAfterDelete, (element) => element.type?.name === 'UndoToast')
  assert.ok(toastElement)
  const toast = toastElement.type(toastElement.props)
  assert.ok(toast)
  assert.equal(deletedHomeElement.props.games.length, 0)
  const undoButton = findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo')
  assert.ok(undoButton)
  undoButton.props.onClick()

  globalThis.__scorebookTestReact.begin()
  const appAfterUndo = App()
  renderedHome = appContent(appAfterUndo).props.children[0].type(appContent(appAfterUndo).props.children[0].props)
  assert.deepEqual(appContent(appAfterUndo).props.children[0].props.games.map((game) => game.id), ['g_mutations'])
  assert.deepEqual(globalThis.__scorebookTestSync.mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'scorebook', operation: 'upsert' },
  ])
})

test('game Undo preserves untouched child timestamps in the full-game upsert', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.activeGameId = null
  state.games[0] = {
    ...state.games[0],
    players: state.games[0].players.map((player, index) => ({ ...player, updatedAt: 100 + index })),
    rounds: [
      { id: 'r_old', updatedAt: 200, entries: { p_one: { score: 500 }, p_two: { score: 700 } } },
      { id: 'r_unrelated', updatedAt: 900, entries: { p_one: { score: 300 }, p_two: { score: 100 } } },
    ],
  }
  prepareStorage(state)
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  initial.props.content.props.children[0].props.onDelete('g_mutations')

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo').props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterUndo = App()
  const restored = afterUndo.props.content.props.children[0].props.games[0]
  assert.deepEqual(restored.players.map((player) => player.updatedAt), [100, 101])
  assert.deepEqual(restored.rounds.map((round) => round.updatedAt), [200, 900])

  const restoredRows = globalThis.__scorebookTestSync.mutations[0].payload.rows
  assert.deepEqual(
    restoredRows.rounds.map((round) => [round.id, round.updated_at]),
    [['r_old', new Date(200).toISOString()], ['r_unrelated', new Date(900).toISOString()]],
  )
})

test('expired game deletion cannot restore the snapshot', async () => {
  const App = await loadComponent('src/App.jsx')
  prepareStorage({ ...gameState(), activeGameId: null })
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const homeElement = appContent(initial).props.children[0]
  const homeTree = homeElement.type(homeElement.props)
  const gameCard = findElement(homeTree, (element) => element.type?.name === 'GameCard')
  findElement(gameCard.type(gameCard.props), (element) => element.props?.['aria-label'] === 'Delete Farkle game').props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = findElement(afterDelete, (element) => element.type?.name === 'UndoToast')
  assert.ok(toast)
  toast.props.onExpire()

  globalThis.__scorebookTestReact.begin()
  const afterExpiry = App()
  assert.deepEqual(appContent(afterExpiry).props.children[0].props.games, [])
  assert.deepEqual(JSON.parse(globalThis.localStorage.getItem('gamescorer.v1')).games, [])
})

test('round deletion restores the complete round snapshot through Undo', async () => {
  const App = await loadComponent('src/App.jsx')
  prepareStorage(gameState())
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  initial.props.content.props.onUpdate({ ...initial.props.content.props.game, rounds: [] })

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  assert.equal(afterDelete.props.content.props.game.rounds.length, 0)
  const toastElement = afterDelete.props.undoToast
  assert.ok(toastElement)
  const toast = toastElement.type(toastElement.props)
  findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo').props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterUndo = App()
  assert.deepEqual(afterUndo.props.content.props.game.rounds.map(({ id, entries }) => ({ id, entries })), gameState().games[0].rounds)
})

test('final-round Undo restores the finished game metadata', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.games[0] = {
    ...state.games[0],
    finishedAt: 123456,
    rounds: [{
      id: 'r_final',
      updatedAt: 500,
      entries: { p_one: { score: 10000 }, p_two: { score: 0 } },
    }],
  }
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  initial.props.content.props.onUpdate({ ...initial.props.content.props.game, rounds: [] })

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  assert.equal(afterDelete.props.content.props.game.finishedAt, null)
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo').props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterUndo = App()
  assert.equal(afterUndo.props.content.props.game.finishedAt, 123456)
})

test('GameView player removal reaches App and queues a join-row tombstone', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  let gameTree = appContent(appTree).type(appContent(appTree).props)
  const playersButton = findElement(gameTree, (element) => element.props?.['aria-label'] === 'Players')
  assert.ok(playersButton)
  playersButton.props.onClick()

  globalThis.__scorebookTestReact.begin()
  gameTree = appContent(appTree).type(appContent(appTree).props)
  const removeButton = findElement(gameTree, (element) => element.props?.['aria-label'] === 'Remove Two')
  assert.ok(removeButton)
  removeButton.props.onClick()

  const mutations = globalThis.__scorebookTestSync.mutations
  assert.deepEqual(mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'scorebook', operation: 'upsert' },
    { entity: 'game_players', operation: 'softDelete' },
  ])
  assert.deepEqual(mutations[1].entityId, { gameId: 'g_mutations', personId: 'p_two' })
  assert.deepEqual(mutations[1].payload, {
    gameId: 'g_mutations',
    personId: 'p_two',
    seatOrder: 1,
    nameSnapshot: 'Two',
  })
  const cachedAfterDelete = enqueueMutation(loadSyncStore(), mutations[1]).cache
  assert.deepEqual(toRemoteRows(cachedAfterDelete).gamePlayers.find((player) => player.person_id === 'p_two'), {
    game_id: 'g_mutations',
    person_id: 'p_two',
    seat_order: 1,
    name_snapshot: 'Two',
    updated_at: new Date(mutations[1].updatedAt).toISOString(),
    deleted_at: new Date(mutations[1].updatedAt).toISOString(),
  })
})

test('invalid new-game routes render Home instead of dereferencing an unknown game', async () => {
  const App = await loadComponent('src/App.jsx')
  prepareStorage({ games: [], roster: [], activeGameId: null })
  globalThis.window.location = { pathname: '/new-game/not-a-real-game' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()

  assert.ok(findElement(appTree, (element) => element.type?.name === 'Home'))
})

test('reserved new-game IDs render Home instead of inherited object properties', async () => {
  const App = await loadComponent('src/App.jsx')

  for (const gameId of ['__proto__', 'constructor', 'toString']) {
    prepareStorage({ games: [], roster: [], activeGameId: null })
    globalThis.window.location = { pathname: `/new-game/${gameId}` }
    resetTestState()

    globalThis.__scorebookTestReact.begin()
    const appTree = App()

    assert.ok(findElement(appTree, (element) => element.type?.name === 'Home'), gameId)
  }
})

test('App follows direct game/home history destinations and excludes deleted games', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const gameRoute = App()
  assert.equal(appContent(gameRoute).type.name, 'GameView')

  globalThis.window.location.pathname = '/'
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  const homeRoute = App()
  assert.ok(findElement(homeRoute, (element) => element.type?.name === 'Home'))

  const deletedState = {
    ...state,
    activeGameId: null,
    games: [{ ...state.games[0], deletedAt: 123 }],
  }
  prepareStorage(deletedState)
  globalThis.window.location = { pathname: '/games' }
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  const gamesRoute = App()
  assert.equal(appContent(gamesRoute).type.name, 'Games')
  assert.deepEqual(appContent(gamesRoute).props.games, [])
})

test('App route matrix renders each people, leaderboard, and games branch', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  const routes = [
    { pathname: '/people', marker: 'People', props: { roster: state.roster, games: state.games } },
    { pathname: '/people/p_one', marker: 'PersonPage', props: { personId: 'p_one' } },
    { pathname: '/leaderboard', marker: 'Leaderboard', props: { roster: state.roster, games: state.games } },
    { pathname: '/games', marker: 'Games', props: { games: state.games } },
    { pathname: '/games/g_mutations', marker: 'GameView', props: { game: state.games[0] } },
  ]

  for (const route of routes) {
    prepareStorage(state)
    globalThis.window.location = { pathname: route.pathname }
    resetTestState()
    globalThis.__scorebookTestReact.begin()

    const appTree = App()
    const content = appContent(appTree)

    assert.equal(content.type.name, route.marker, route.pathname)
    for (const [prop, value] of Object.entries(route.props)) {
      assert.deepEqual(content.props[prop], value, `${route.pathname} ${prop}`)
    }
  }
})

test('App popstate subscription clears activeGameId when leaving a game route', async () => {
  const App = await loadComponent('src/App.jsx', { realEffects: true })
  prepareStorage(gameState())
  globalThis.window.location = { pathname: '/games/g_mutations' }
  const handlers = new Map()
  globalThis.window.addEventListener = (type, handler) => handlers.set(type, handler)
  globalThis.window.removeEventListener = (type) => handlers.delete(type)
  globalThis.window.dispatchEvent = (event) => handlers.get(event.type)?.(event)
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const gameTree = App()
  assert.equal(appContent(gameTree).type.name, 'GameView')
  globalThis.__scorebookTestReact.flushEffects()
  assert.ok(handlers.has('popstate'))
  gameTree.props.content.props.onUpdate({ ...gameTree.props.content.props.game, rounds: [] })

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  assert.ok(afterDelete.props.undoToast)

  globalThis.window.location.pathname = '/people'
  globalThis.window.dispatchEvent({ type: 'popstate' })

  assert.equal(globalThis.__scorebookTestReactState.slots[0].activeGameId, null)
  globalThis.__scorebookTestReact.begin()
  const peopleTree = App()
  assert.equal(appContent(peopleTree).type.name, 'People')
  assert.ok(peopleTree.props.undoToast)
  globalThis.__scorebookTestReact.flushEffects()
  assert.equal(JSON.parse(globalThis.localStorage.getItem('gamescorer.v1')).activeGameId, null)
})

test('App surfaces the exact conflict notice on routes without DataPanel', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/people' }
  resetTestState()
  globalThis.__scorebookTestSync.error = 'This was changed on another device. The shared version is now shown.'

  globalThis.__scorebookTestReact.begin()
  const appTree = App()

  assert.equal(appTree.type.name, 'AppShell')
  assert.equal(appTree.props.content.type.name, 'People')
  assert.equal(appTree.props.syncNotice.props.role, 'status')
  assert.equal(appTree.props.syncNotice.props['aria-live'], 'polite')
  assert.equal(
    textOf(appTree.props.syncNotice),
    'This was changed on another device. The shared version is now shown.',
  )
})
