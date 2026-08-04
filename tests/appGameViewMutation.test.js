import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { fromRemoteRows, toRemoteRows } from '../src/lib/cloudState.js'
import { enqueueMutation, loadSyncStore, mergeRemoteState, saveSyncStore } from '../src/lib/sync.js'

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
globalThis.__scorebookTestReact.begin = () => { state.cursor = 0 }
globalThis.__scorebookTestReact.reset = () => {
  state.slots = []; state.cursor = 0; state.effectDeps = []; state.effectCleanups = []; state.pendingEffects = []
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
export function useCloudSync(currentState, setState) {
  if (state.hydratedState && currentState !== state.hydratedState) {
    setState(state.hydratedState)
    state.hydratedState = null
  }
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
  for (const cleanup of globalThis.__scorebookTestReactState.effectCleanups ?? []) cleanup?.()
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReactState.effectDeps = []
  globalThis.__scorebookTestReactState.effectCleanups = []
  globalThis.__scorebookTestReactState.pendingEffects = []
  globalThis.__scorebookTestSync.mutations = []
  globalThis.__scorebookTestSync.error = null
  globalThis.__scorebookTestSync.hydratedState = null
}

async function settleEffects() {
  globalThis.__scorebookTestReact.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))
}

test('App round deletion queues the round tombstone before the updated game', async () => {
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
    { entity: 'rounds', operation: 'softDelete' },
    { entity: 'scorebook', operation: 'upsert' },
  ])
  assert.deepEqual(mutations[0].payload, {
    gameId: 'g_mutations',
    roundIndex: 0,
    entries: { p_one: { score: 500 }, p_two: { score: 700 } },
  })
  assert.equal(mutations[1].payload.rows.games[0].id, 'g_mutations')
  assert.equal(mutations[1].payload.rows.games[0].finished_at, null)
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

test('initial migration stamps local history newer than a stale incremental cursor', async () => {
  const App = await loadComponent('src/App.jsx', { realEffects: true })
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/' }
  globalThis.localStorage.setItem('gamescorer.cloud.v1', JSON.stringify({
    lastSyncAt: '2026-08-04T00:00:00.000Z',
    outbox: [],
  }))
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  await settleEffects()
  assert.equal(findElement(appTree, (element) => element.type?.name === 'MigrationPanel'), null)

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  assert.equal(mutation.initialMigration, true)
  const rowVersions = [
    ...mutation.payload.rows.people,
    ...mutation.payload.rows.games,
    ...mutation.payload.rows.gamePlayers,
    ...mutation.payload.rows.rounds,
  ].map((row) => row.updated_at)
  assert.ok(rowVersions.length > 0)
  assert.equal(new Set(rowVersions).size, 1)
  assert.ok(Date.parse(rowVersions[0]) > Date.parse('2026-08-04T00:00:00.000Z'))
  assert.equal(mutation.payload.rows.games[0].created_at, '1970-01-01T00:00:00.100Z')
})

test('first-run migration skips local rows already present in the cloud snapshot', async () => {
  const App = await loadComponent('src/App.jsx', { realEffects: true })
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/' }
  const cloudState = fromRemoteRows(toRemoteRows(state), null)
  saveSyncStore({
    cache: cloudState,
    reconciledCache: cloudState,
    lastSyncAt: '2026-08-04T00:00:00.000Z',
    outbox: [],
    initialMigrationCompleted: false,
  })
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  await settleEffects()
  assert.equal(findElement(appTree, (element) => element.type?.name === 'MigrationPanel'), null)

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  assert.deepEqual(mutation.payload.rows, { people: [], games: [], gamePlayers: [], rounds: [] })
})

test('first-run migration reconciles conflicting same-ID local rows to cloud authority before display', async () => {
  const App = await loadComponent('src/App.jsx', { realEffects: true })
  const localState = gameState()
  prepareStorage(localState)
  globalThis.window.location = { pathname: '/' }
  const cloudState = fromRemoteRows(toRemoteRows({
    ...localState,
    roster: [{ id: 'p_one', name: 'Cloud One' }, { id: 'p_two', name: 'Two' }],
    games: [{
      ...localState.games[0],
      settings: { ...localState.games[0].settings, target: 500 },
      players: [{ id: 'p_one', name: 'Cloud One' }, { id: 'p_two', name: 'Two' }],
      rounds: [{ id: 'r_removed', entries: { p_one: { score: 900 }, p_two: { score: 700 } } }],
    }],
  }), null)
  saveSyncStore({
    cache: cloudState,
    reconciledCache: cloudState,
    lastSyncAt: '2026-08-04T00:00:00.000Z',
    outbox: [],
    initialMigrationCompleted: false,
  })
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  await settleEffects()
  assert.equal(findElement(appTree, (element) => element.type?.name === 'MigrationPanel'), null)

  globalThis.__scorebookTestReact.begin()
  const refreshedTree = App()
  const home = findElement(refreshedTree, (element) => element.type?.name === 'Home')
  assert.ok(home)
  assert.equal(home.props.games[0].settings.target, 500)
  assert.equal(home.props.games[0].rounds[0].entries.p_one.score, 900)
  assert.equal(home.props.games[0].players[0].name, 'Cloud One')
  assert.deepEqual(globalThis.__scorebookTestSync.mutations[0].payload.rows, {
    people: [], games: [], gamePlayers: [], rounds: [],
  })
})

test('JSON import stamps new rows with a fresh monotonic sync version and preserves created_at', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/' }
  globalThis.localStorage.setItem('gamescorer.cloud.v1', JSON.stringify({
    lastSyncAt: '2026-08-04T00:00:00.000Z',
    outbox: [],
  }))
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  let appTree = App()
  const homeComponent = childrenOf(appContent(appTree))[0]
  const homeTree = homeComponent.type(homeComponent.props)
  findElement(homeTree, (element) => element.props?.['aria-label'] === 'Data and backup').props.onClick()
  globalThis.__scorebookTestReact.begin()
  appTree = App()
  const dataPanel = findElement(appTree, (element) => element.type?.name === 'DataPanel')
  assert.ok(dataPanel)
  const importedGame = {
    ...state.games[0],
    id: 'g_imported',
    createdAt: 123,
    updatedAt: 456,
    rounds: [{ id: 'r_imported', entries: {} }],
  }
  dataPanel.props.onImport({ ...state, games: [...state.games, importedGame] })

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  const rows = [
    ...mutation.payload.rows.games,
    ...mutation.payload.rows.gamePlayers,
    ...mutation.payload.rows.rounds,
  ]
  assert.ok(rows.length > 0)
  assert.equal(new Set(rows.map((row) => row.updated_at)).size, 1)
  assert.ok(Date.parse(rows[0].updated_at) > Date.parse('2026-08-04T00:00:00.000Z'))
  assert.equal(mutation.payload.rows.games.find((game) => game.id === 'g_imported').created_at, '1970-01-01T00:00:00.123Z')
})

test('new people receive current timestamps before their first incremental upsert', async () => {
  const App = await loadComponent('src/App.jsx')
  prepareStorage({ games: [], roster: [], activeGameId: null })
  globalThis.window.location = { pathname: '/new-game/farkle' }
  globalThis.localStorage.setItem('gamescorer.cloud.v1', JSON.stringify({
    lastSyncAt: '2026-08-04T00:00:00.000Z',
    outbox: [],
  }))
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  assert.equal(appContent(appTree).type.name, 'NewGame')
  appContent(appTree).props.onAddToRoster('New Person')

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  const person = mutation.payload.rows.people.find((candidate) => candidate.name === 'New Person')
  assert.ok(person)
  assert.ok(Date.parse(person.updated_at) > Date.parse('2026-08-04T00:00:00.000Z'))
  assert.equal(person.created_at, person.updated_at)
})

test('editing a synced round advances only that round in the queued mutation', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.games[0].rounds = [
    { id: 'r_a', updatedAt: 100, entries: { p_one: { score: 500 }, p_two: { score: 700 } } },
    { id: 'r_b', updatedAt: 900, entries: { p_one: { score: 300 }, p_two: { score: 100 } } },
  ]
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({
    ...game,
    rounds: [
      { ...game.rounds[0], entries: { p_one: { score: 800 }, p_two: { score: 700 } } },
      game.rounds[1],
    ],
  })

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  assert.equal(mutation.operation, 'upsert')
  assert.deepEqual(mutation.payload.rows.games, [])
  assert.equal(mutation.payload.rows.rounds.length, 1)
  assert.equal(mutation.payload.rows.rounds[0].id, 'r_a')
  assert.ok(Date.parse(mutation.payload.rows.rounds[0].updated_at) > 100)
  assert.equal(mutation.payload.rows.rounds[0].entries.p_one.score, 800)
})

test('score-only round edits preserve remote parent metadata during reconciliation', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.games[0].rounds = [
    { id: 'r_a', updatedAt: 100, entries: { p_one: { score: 500 }, p_two: { score: 700 } } },
    { id: 'r_b', updatedAt: 150, entries: { p_one: { score: 300 }, p_two: { score: 100 } } },
  ]
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({
    ...game,
    rounds: [
      { ...game.rounds[0], entries: { p_one: { score: 800 }, p_two: { score: 700 } } },
      game.rounds[1],
    ],
  })

  const mutation = globalThis.__scorebookTestSync.mutations[0]
  const localState = mutation.state
  const localGame = localState.games[0]
  assert.equal(localGame.updatedAt, state.games[0].updatedAt)
  assert.deepEqual(mutation.payload.rows.games, [])

  const remoteUpdatedAt = Math.max(state.games[0].updatedAt + 1, localGame.updatedAt - 1)
  const remoteGame = {
    ...state.games[0],
    updatedAt: remoteUpdatedAt,
    finishedAt: 987654,
    rounds: [
      state.games[0].rounds[0],
      { ...state.games[0].rounds[1], updatedAt: remoteUpdatedAt, entries: { p_one: { score: 900 }, p_two: { score: 100 } } },
    ],
  }
  const remoteState = fromRemoteRows(toRemoteRows({ ...state, games: [remoteGame] }), null)
  const merged = mergeRemoteState(localState, remoteState)

  assert.equal(merged.games[0].finishedAt, remoteGame.finishedAt)
  assert.deepEqual(
    merged.games[0].rounds
      .map((round) => [round.id, round.entries])
      .sort(([left], [right]) => left.localeCompare(right)),
    [
      ['r_a', localGame.rounds[0].entries],
      ['r_b', remoteGame.rounds[1].entries],
    ],
  )
})

test('round history rows open the editor with Enter and Space', async () => {
  const App = await loadComponent('src/App.jsx')
  prepareStorage(gameState())
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  const gameView = appContent(appTree)
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  let gameTree = gameView.type(gameView.props)
  const historyRow = findElement(gameTree, (element) => element.type === 'tr' && element.props?.onClick)
  assert.equal(historyRow.props.role, 'button')
  assert.equal(historyRow.props['aria-label'], 'Edit turn 1')
  assert.equal(historyRow.props.tabIndex, 0)

  let prevented = false
  historyRow.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  globalThis.__scorebookTestReact.begin()
  gameTree = gameView.type(gameView.props)
  assert.ok(findElement(gameTree, (element) => element.props?.onDelete))

  findElement(gameTree, (element) => element.props?.onClose).props.onClose()
  globalThis.__scorebookTestReact.begin()
  gameTree = gameView.type(gameView.props)
  const closedHistoryRow = findElement(gameTree, (element) => element.type === 'tr' && element.props?.onClick)
  closedHistoryRow.props.onKeyDown({ key: ' ', preventDefault() {} })
  globalThis.__scorebookTestReact.begin()
  gameTree = gameView.type(gameView.props)
  assert.ok(findElement(gameTree, (element) => element.props?.onDelete))
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
  const restoreMutation = globalThis.__scorebookTestSync.mutations[0]
  assert.deepEqual(globalThis.__scorebookTestSync.mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'scorebook', operation: 'restore' },
  ])
  assert.equal(restoreMutation.restore.games[0].id, 'g_mutations')
  assert.equal(restoreMutation.restore.games[0].updated_at, restoreMutation.restore.games[0].deleted_at)
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

test('game Undo preserves synced non-enumerable round timestamps', async () => {
  const App = await loadComponent('src/App.jsx')
  const source = gameState()
  source.activeGameId = null
  source.games[0].updatedAt = 1000
  source.games[0].rounds[0].updatedAt = 900
  const syncedState = fromRemoteRows(toRemoteRows(source), null)
  assert.equal(Object.prototype.propertyIsEnumerable.call(syncedState.games[0].rounds[0], 'updatedAt'), false)
  prepareStorage(source)
  resetTestState()
  globalThis.__scorebookTestSync.hydratedState = syncedState

  globalThis.__scorebookTestReact.begin()
  App()
  globalThis.__scorebookTestReact.begin()
  const initial = App()
  initial.props.content.props.children[0].props.onDelete('g_mutations')

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo').props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterUndo = App()
  const restoredRound = afterUndo.props.content.props.children[0].props.games[0].rounds[0]
  assert.equal(restoredRound.updatedAt, 900)
  assert.equal(Object.prototype.propertyIsEnumerable.call(restoredRound, 'updatedAt'), false)
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
    { entity: 'game_players', operation: 'softDelete' },
    { entity: 'scorebook', operation: 'upsert' },
  ])
  assert.deepEqual(mutations[0].entityId, { gameId: 'g_mutations', personId: 'p_two' })
  assert.deepEqual(mutations[0].payload, {
    gameId: 'g_mutations',
    personId: 'p_two',
    seatOrder: 1,
    nameSnapshot: 'Two',
  })
  const cachedAfterDelete = enqueueMutation(loadSyncStore(), mutations[0]).cache
  assert.deepEqual(toRemoteRows(cachedAfterDelete).gamePlayers.find((player) => player.person_id === 'p_two'), {
    game_id: 'g_mutations',
    person_id: 'p_two',
    seat_order: 1,
    name_snapshot: 'Two',
    updated_at: new Date(mutations[0].updatedAt).toISOString(),
    deleted_at: new Date(mutations[0].updatedAt).toISOString(),
  })
})

test('player Undo restores the membership snapshot, scores, and shifted seats', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.roster = [...state.roster, { id: 'p_three', name: 'Three' }]
  state.games[0].players = [
    state.games[0].players[0],
    state.games[0].players[1],
    { id: 'p_three', name: 'Three' },
  ]
  state.games[0].rounds = [{
    id: 'r_players',
    entries: {
      p_one: { score: 500 },
      p_two: { score: 700 },
      p_three: { score: 300 },
    },
  }]
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({
    ...game,
    players: game.players.filter((player) => player.id !== 'p_two'),
    rounds: game.rounds.map((round) => {
      const entries = { ...round.entries }
      delete entries.p_two
      return { ...round, entries }
    }),
  })

  assert.deepEqual(globalThis.__scorebookTestSync.mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'game_players', operation: 'softDelete' },
    { entity: 'scorebook', operation: 'upsert' },
  ])
  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  assert.match(textOf(toast), /Player removed.*Undo is available for 10 seconds/i)
  const undoButton = findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo')
  undoButton.props.onClick()

  globalThis.__scorebookTestReact.begin()
  const afterUndo = App()
  const restoredGame = appContent(afterUndo).props.game
  assert.deepEqual(restoredGame.players.map((player) => player.id), ['p_one', 'p_two', 'p_three'])
  assert.deepEqual(restoredGame.rounds[0].entries, {
    p_one: { score: 500 },
    p_two: { score: 700 },
    p_three: { score: 300 },
  })

  assert.deepEqual(globalThis.__scorebookTestSync.mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'scorebook', operation: 'restore' },
  ])
  const restoreMutation = globalThis.__scorebookTestSync.mutations.find((mutation) => mutation.operation === 'restore')
  assert.ok(restoreMutation)
  assert.deepEqual(restoreMutation.payload.rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]), [
    ['p_two', 1], ['p_three', 2],
  ])
  assert.deepEqual(restoreMutation.restore.gamePlayers, [{
    game_id: 'g_mutations',
    person_id: 'p_two',
    updated_at: restoreMutation.restore.gamePlayers[0].deleted_at,
    deleted_at: restoreMutation.restore.gamePlayers[0].deleted_at,
  }])
})

test('player Undo expiry leaves the membership deleted', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  prepareStorage(state)
  globalThis.window.location = { pathname: '/games/g_mutations' }
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({
    ...game,
    players: game.players.filter((player) => player.id !== 'p_two'),
    rounds: game.rounds.map((round) => {
      const entries = { ...round.entries }
      delete entries.p_two
      return { ...round, entries }
    }),
  })

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  afterDelete.props.undoToast.props.onExpire()
  globalThis.__scorebookTestReact.begin()
  const afterExpiry = App()
  assert.equal(afterExpiry.props.undoToast, null)
  assert.deepEqual(appContent(afterExpiry).props.game.players.map((player) => player.id), ['p_one'])
  assert.equal(globalThis.__scorebookTestSync.mutations.some((mutation) => mutation.operation === 'restore'), false)
})

test('middle player removal queues later players with shifted seat order', async () => {
  const App = await loadComponent('src/App.jsx')
  const state = gameState()
  state.roster = [...state.roster, { id: 'p_three', name: 'Three' }]
  state.games[0].players = [
    state.games[0].players[0],
    state.games[0].players[1],
    { id: 'p_three', name: 'Three' },
  ]
  state.games[0].rounds = [{
    id: 'r_players',
    entries: {
      p_one: { score: 500 },
      p_two: { score: 700 },
      p_three: { score: 300 },
    },
  }]
  prepareStorage(state)
  resetTestState()

  globalThis.__scorebookTestReact.begin()
  const appTree = App()
  globalThis.__scorebookTestReact.reset()
  globalThis.__scorebookTestReact.begin()
  let gameTree = appContent(appTree).type(appContent(appTree).props)
  findElement(gameTree, (element) => element.props?.['aria-label'] === 'Players').props.onClick()

  globalThis.__scorebookTestReact.begin()
  gameTree = appContent(appTree).type(appContent(appTree).props)
  findElement(gameTree, (element) => element.props?.['aria-label'] === 'Remove Two').props.onClick()

  const mutations = globalThis.__scorebookTestSync.mutations
  const scorebookMutation = mutations.find((mutation) => mutation.entity === 'scorebook')
  assert.deepEqual(
    scorebookMutation.payload.rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]),
    [['p_three', 1]],
  )
  assert.deepEqual(mutations.find((mutation) => mutation.entity === 'game_players').payload, {
    gameId: 'g_mutations',
    personId: 'p_two',
    seatOrder: 1,
    nameSnapshot: 'Two',
  })
})

test('synced earlier round deletion sends shifted rows with new versions', async () => {
  const App = await loadComponent('src/App.jsx')
  const source = gameState()
  source.activeGameId = 'g_mutations'
  source.games[0].updatedAt = 1000
  source.games[0].rounds = [
    { id: 'r_one', updatedAt: 1100, entries: { p_one: { score: 100 }, p_two: { score: 200 } } },
    { id: 'r_two', updatedAt: 1200, entries: { p_one: { score: 300 }, p_two: { score: 400 } } },
    { id: 'r_three', updatedAt: 1300, entries: { p_one: { score: 500 }, p_two: { score: 600 } } },
  ]
  const synced = fromRemoteRows(toRemoteRows(source), source.activeGameId)
  prepareStorage(source)
  resetTestState()
  globalThis.__scorebookTestSync.hydratedState = synced

  globalThis.__scorebookTestReact.begin()
  App()
  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({ ...game, rounds: game.rounds.slice(1) })

  const mutations = globalThis.__scorebookTestSync.mutations
  assert.deepEqual(mutations.map(({ entity, operation }) => ({ entity, operation })), [
    { entity: 'rounds', operation: 'softDelete' },
    { entity: 'scorebook', operation: 'upsert' },
  ])
  const rows = mutations[1].payload.rows
  assert.deepEqual(rows.rounds.map(({ id, round_index }) => [id, round_index]), [['r_two', 0], ['r_three', 1]])
  assert.ok(Date.parse(rows.rounds.find((round) => round.id === 'r_two').updated_at) > 1200)
  assert.ok(Date.parse(rows.rounds.find((round) => round.id === 'r_three').updated_at) > 1300)
})

test('round Undo restores shifted rows with explicit tombstone metadata', async () => {
  const App = await loadComponent('src/App.jsx')
  const source = gameState()
  source.activeGameId = 'g_mutations'
  source.games[0].updatedAt = 1000
  source.games[0].rounds = [
    { id: 'r_one', updatedAt: 1100, entries: { p_one: { score: 100 }, p_two: { score: 200 } } },
    { id: 'r_two', updatedAt: 1200, entries: { p_one: { score: 300 }, p_two: { score: 400 } } },
    { id: 'r_three', updatedAt: 1300, entries: { p_one: { score: 500 }, p_two: { score: 600 } } },
  ]
  const synced = fromRemoteRows(toRemoteRows(source), source.activeGameId)
  prepareStorage(source)
  resetTestState()
  globalThis.__scorebookTestSync.hydratedState = synced

  globalThis.__scorebookTestReact.begin()
  App()
  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({ ...game, rounds: game.rounds.slice(1) })

  globalThis.__scorebookTestReact.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  findElement(toast, (element) => element.type === 'button' && textOf(element) === 'Undo').props.onClick()

  const mutations = globalThis.__scorebookTestSync.mutations
  const restoreMutation = mutations.find((mutation) => mutation.operation === 'restore')
  assert.ok(restoreMutation)
  assert.deepEqual(restoreMutation.payload.rows.rounds.map(({ id, round_index }) => [id, round_index]), [
    ['r_one', 0], ['r_two', 1], ['r_three', 2],
  ])
  assert.deepEqual(restoreMutation.restore.rounds, [{
    id: 'r_one', game_id: 'g_mutations',
    updated_at: restoreMutation.restore.rounds[0].deleted_at,
    deleted_at: restoreMutation.restore.rounds[0].deleted_at,
  }])
})

test('synced earlier player removal sends shifted seats with new versions', async () => {
  const App = await loadComponent('src/App.jsx')
  const source = gameState()
  source.activeGameId = 'g_mutations'
  source.roster = [...source.roster, { id: 'p_three', name: 'Three' }]
  source.games[0].updatedAt = 1000
  source.games[0].players = [
    { id: 'p_one', name: 'One', updatedAt: 1100 },
    { id: 'p_two', name: 'Two', updatedAt: 1200 },
    { id: 'p_three', name: 'Three', updatedAt: 1300 },
  ]
  const synced = fromRemoteRows(toRemoteRows(source), source.activeGameId)
  prepareStorage(source)
  resetTestState()
  globalThis.__scorebookTestSync.hydratedState = synced

  globalThis.__scorebookTestReact.begin()
  App()
  globalThis.__scorebookTestReact.begin()
  const initial = App()
  const game = initial.props.content.props.game
  initial.props.content.props.onUpdate({ ...game, players: game.players.slice(1) })

  const scorebookMutation = globalThis.__scorebookTestSync.mutations.find((mutation) => mutation.entity === 'scorebook')
  const rows = scorebookMutation.payload.rows
  assert.deepEqual(rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]), [['p_two', 0], ['p_three', 1]])
  assert.ok(Date.parse(rows.gamePlayers.find((player) => player.person_id === 'p_two').updated_at) > 1200)
  assert.ok(Date.parse(rows.gamePlayers.find((player) => player.person_id === 'p_three').updated_at) > 1300)
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
