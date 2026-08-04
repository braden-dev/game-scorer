import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { fromRemoteRows, toRemoteRows } from '../src/lib/cloudState.js'
import { loadSyncStore } from '../src/lib/sync.js'
import { loadReconciledState, saveState, saveStateToCloudCache, shouldOfferInitialMigration } from '../src/lib/storage.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
}

const fakeReactWithEffects = `
const state = globalThis.__scorebookIntegrationReact ??= { slots: [], cursor: 0, effectDeps: [], pendingEffects: [], effectCleanups: [] }
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
export function useEffect(effect, dependencies) {
  const index = state.cursor++
  const previous = state.effectDeps[index]
  const changed = !dependencies || !previous || dependencies.length !== previous.length
    || dependencies.some((value, dependencyIndex) => value !== previous[dependencyIndex])
  state.effectDeps[index] = dependencies
  if (changed) state.pendingEffects.push({ index, effect })
}
export function useCallback(fn) { return fn }
export function useMemo(factory) { return factory() }
globalThis.__scorebookIntegrationReactControl = {
  reset() { state.slots = []; state.cursor = 0; state.effectDeps = []; state.pendingEffects = []; state.effectCleanups = [] },
  begin() { state.cursor = 0 },
  async flushEffects() {
    for (const { index, effect } of state.pendingEffects.splice(0)) {
      state.effectCleanups[index]?.()
      const cleanup = effect()
      state.effectCleanups[index] = typeof cleanup === 'function' ? cleanup : null
    }
    await Promise.resolve()
  },
}
`

const fakeSupabase = `
export const supabase = {}
export function cloudConfigured() { return true }
`

const fakeSync = `
const state = globalThis.__scorebookIntegrationSync ??= { outbox: [] }
const api = globalThis.__scorebookIntegrationCloudApi ??= {
  mutations: [],
  async fetchSnapshot() { return { people: [], games: [], gamePlayers: [], rounds: [] } },
  async upsertRows(rows, mutation) { this.mutations.push({ rows, initialMigration: mutation.initialMigration }) },
}
export const CONFLICT_MESSAGE = 'This was changed on another device. The shared version is now shown.'
export function useCloudSync() {
  return {
    status: 'synced',
    pendingCount: state.outbox.length,
    error: null,
    async syncNow(options = {}) {
      if (options.initial) await api.fetchSnapshot()
      const mutation = state.outbox.shift()
      if (mutation) await api.upsertRows(mutation.payload.rows, mutation)
    },
    enqueueStateMutation(mutation) { state.outbox.push(mutation); return mutation },
    updateSyncStore(update) {
      const current = JSON.parse(localStorage.getItem('gamescorer.cloud.v1') ?? '{}')
      localStorage.setItem('gamescorer.cloud.v1', JSON.stringify({ ...current, ...update }))
    },
    cancelSyncMutations() {},
  }
}
`

async function loadAppForIntegrationTest() {
  const aliases = {
    react: fakeReactWithEffects,
    'react/jsx-runtime': fakeReactWithEffects,
    supabase: fakeSupabase,
    sync: fakeSync,
    wakeLock: 'export function useWakeLock() {}',
  }
  const plugin = {
    name: 'scorebook-app-integration-test-aliases',
    setup(build) {
      build.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'scorebook-integration-test' }))
      build.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: 'react/jsx-runtime', namespace: 'scorebook-integration-test' }))
      build.onResolve({ filter: /^\.\/lib\/supabase\.js$/ }, () => ({ path: 'supabase', namespace: 'scorebook-integration-test' }))
      build.onResolve({ filter: /^\.\/lib\/useCloudSync\.js$/ }, () => ({ path: 'sync', namespace: 'scorebook-integration-test' }))
      build.onResolve({ filter: /^\.\.\/lib\/useWakeLock\.js$/ }, () => ({ path: 'wakeLock', namespace: 'scorebook-integration-test' }))
      build.onLoad({ filter: /.*/, namespace: 'scorebook-integration-test' }, ({ path }) => ({ contents: aliases[path], loader: 'js' }))
    },
  }
  const result = await esbuild.build({
    entryPoints: ['src/App.jsx'],
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
  const children = element.type?.name === 'AppShell'
    ? [element.props.content, element.props.undoToast, element.props.syncNotice]
    : childrenOf(element)
  for (const child of children) {
    const match = findElement(child, predicate)
    if (match) return match
  }
  return null
}

test('persists the next nested state in the cloud cache without uploading activeGameId', () => {
  const storage = new MemoryStorage()
  saveState({ games: [{ id: 'legacy' }], roster: [] }, storage)
  const nextState = {
    activeGameId: 'g_local',
    roster: [{ id: 'p_one', name: 'One' }],
    games: [],
  }

  saveStateToCloudCache(nextState, storage)

  const store = loadSyncStore(storage)
  assert.deepEqual(JSON.parse(storage.getItem('gamescorer.v1')), { games: [{ id: 'legacy' }], roster: [] })
  assert.deepEqual(store.cache.roster, nextState.roster)
  assert.equal(store.cache.activeGameId, 'g_local')
  assert.deepEqual(toRemoteRows(store.cache).people.map(({ id, name }) => ({ id, name })), [
    { id: 'p_one', name: 'One' },
  ])
  assert.equal(toRemoteRows(store.cache).games[0], undefined)
})

test('cloud cache hydration keeps the device-local active game while remote rows stay normalized', () => {
  const state = fromRemoteRows({
    people: [{ id: 'p_one', name: 'One', updated_at: '2026-01-01T00:00:00.000Z' }],
    games: [],
    gamePlayers: [],
    rounds: [],
  }, 'g_local')

  assert.equal(state.activeGameId, 'g_local')
  assert.equal(toRemoteRows(state).people[0].id, 'p_one')
  assert.equal('activeGameId' in toRemoteRows(state), false)
})

test('does not offer migration for a device that started without local data', () => {
  assert.equal(shouldOfferInitialMigration({
    configured: true,
    hadLocalDataAtStartup: false,
    initialMigrationCompleted: false,
  }), false)
  assert.equal(shouldOfferInitialMigration({
    configured: true,
    hadLocalDataAtStartup: true,
    initialMigrationCompleted: false,
  }), true)
})

test('automatically migrates local history after startup without rendering a migration prompt', async () => {
  const App = await loadAppForIntegrationTest()
  const storage = new MemoryStorage()
  saveState({
    activeGameId: null,
    roster: [{ id: 'p_local', name: 'Local Player' }],
    games: [{
      id: 'g_local',
      gameId: 'farkle',
      createdAt: 1,
      updatedAt: 2,
      players: [{ id: 'p_local', name: 'Local Player' }],
      settings: {},
      rounds: [],
      finishedAt: null,
    }],
  }, storage)
  storage.setItem('gamescorer.cloud.v1', JSON.stringify({ initialMigrationCompleted: false, outbox: [] }))
  globalThis.localStorage = storage
  globalThis.window = {
    location: { pathname: '/' },
    matchMedia: () => ({ matches: false }),
    navigator: { standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.__scorebookIntegrationReactControl.reset()
  globalThis.__scorebookIntegrationSync.outbox = []
  globalThis.__scorebookIntegrationCloudApi.mutations = []

  globalThis.__scorebookIntegrationReactControl.begin()
  const appTree = App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations.map(({ initialMigration }) => initialMigration), [true])
  assert.equal(findElement(appTree, (element) => element.type?.name === 'MigrationPanel'), null)
})

test('does not expose a cloud backup before the first successful sync', () => {
  const storage = new MemoryStorage()
  saveStateToCloudCache({ games: [{ id: 'g_local' }], roster: [] }, storage)
  assert.equal(loadReconciledState(storage), null)
})
