import test from 'node:test'
import assert from 'node:assert/strict'
import * as esbuild from 'esbuild'
import { fromRemoteRows, toRemoteRows } from '../src/lib/cloudState.js'
import { loadSyncStore, saveSyncStore } from '../src/lib/sync.js'
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
import { useEffect } from 'react'
const STORE_KEY = 'gamescorer.cloud.v1'
const state = globalThis.__scorebookIntegrationSync ??= { outbox: [], status: 'synced', lastError: null }
function readStore() {
  return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}')
}
function persistStore(updates = {}) {
  const current = readStore()
  localStorage.setItem(STORE_KEY, JSON.stringify({
    ...current,
    ...updates,
    outbox: state.outbox,
    lastError: state.lastError,
  }))
}
const api = globalThis.__scorebookIntegrationCloudApi ??= {
  mutations: [],
  softDeletes: [],
  restoreCalls: [],
  failFetch: false,
  failUpsert: false,
  deleteGate: null,
  preserveExplicitUpdatedAt: false,
  serverUpdatedAt: null,
  async fetchSnapshot() {
    if (this.failFetch) throw new Error('snapshot unavailable')
    return { people: [], games: [], gamePlayers: [], rounds: [] }
  },
  async upsertRows(rows, mutation) {
    if (this.failUpsert) throw new Error('migration upload unavailable')
    this.mutations.push({ rows, initialMigration: mutation.initialMigration })
  },
  async softDelete(entity, entityId, updatedAt) {
    this.softDeletes.push({ entity, entityId, updatedAt })
    if (this.deleteGate) await this.deleteGate
    this.serverUpdatedAt = this.preserveExplicitUpdatedAt
      ? new Date(updatedAt).toISOString()
      : '2026-08-04T00:00:10.000Z'
    return {
      id: typeof entityId === 'object' ? entityId.id : entityId,
      updated_at: this.serverUpdatedAt,
      deleted_at: updatedAt,
    }
  },
  async restoreRows(rows, expectedTombstones) {
    this.restoreCalls.push({ rows, expectedTombstones })
    const expected = expectedTombstones?.games?.[0]
    if (this.serverUpdatedAt && expected?.updated_at !== this.serverUpdatedAt) {
      throw new Error('restore conflict: tombstone version changed')
    }
    return rows
  },
}
export const CONFLICT_MESSAGE = 'This was changed on another device. The shared version is now shown.'
export function useCloudSync() {
  const syncNow = async (options = {}) => {
    if (globalThis.navigator?.onLine === false) {
      state.status = 'offline'
      state.lastError = null
      persistStore()
      return { ok: false, reason: 'offline', fullSnapshot: Boolean(options.initial) }
    }
    if (options.initial) {
      try {
        await api.fetchSnapshot()
      } catch (error) {
        state.status = 'error'
        state.lastError = error.message
        persistStore()
        return { ok: false, reason: 'error', fullSnapshot: true }
      }
      state.status = 'synced'
      state.lastError = null
      persistStore({
        cache: { games: [], roster: [], activeGameId: null },
        reconciledCache: { games: [], roster: [], activeGameId: null },
        lastSyncAt: new Date().toISOString(),
      })
    }
    const mutation = state.outbox[0]
    if (!mutation) {
      state.status = 'synced'
      state.lastError = null
      persistStore()
      return { ok: true, fullSnapshot: true }
    }
    try {
      if (mutation.operation === 'softDelete') {
        await api.softDelete(mutation.entity, mutation.entityId, mutation.updatedAt)
      } else if (mutation.operation === 'restore') {
        await api.restoreRows(mutation.payload.rows, mutation.restore)
      } else {
        await api.upsertRows(mutation.payload.rows, mutation)
      }
      if (state.outbox[0]?.id === mutation.id) state.outbox.shift()
      state.status = 'synced'
      state.lastError = null
    } catch (error) {
      state.status = 'error'
      state.lastError = error.message
      persistStore()
      return { ok: false, reason: 'error', fullSnapshot: Boolean(options.initial) }
    }
    persistStore(mutation.initialMigration ? { initialMigrationCompleted: true } : {})
    return { ok: true, fullSnapshot: Boolean(options.initial) }
  }
  state.syncNow = syncNow
  useEffect(() => {
    const retry = () => { void syncNow() }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [])
  return {
    status: state.status,
    pendingCount: state.outbox.length,
    error: state.lastError,
    syncNow,
    enqueueStateMutation(mutation) {
      state.outbox.push(mutation)
      state.status = 'pending'
      persistStore()
      return mutation
    },
    updateSyncStore(update) {
      const current = readStore()
      localStorage.setItem('gamescorer.cloud.v1', JSON.stringify({ ...current, ...update }))
    },
    cancelSyncMutations(predicate) {
      state.outbox = state.outbox.filter((mutation) => !predicate?.(mutation))
      persistStore()
    },
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
  for (const child of childrenOf(element)) {
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

test('restores an in-flight game Undo after the serialized delete returns', async () => {
  const App = await loadAppForIntegrationTest()
  const storage = new MemoryStorage()
  saveState({
    activeGameId: null,
    roster: [{ id: 'p_local', name: 'Local Player' }],
    games: [{
      id: 'g_inflight_undo',
      gameId: 'farkle',
      createdAt: 1,
      updatedAt: 2,
      players: [{ id: 'p_local', name: 'Local Player' }],
      settings: {},
      rounds: [],
      finishedAt: null,
    }],
  }, storage)
  storage.setItem('gamescorer.cloud.v1', JSON.stringify({ initialMigrationCompleted: true, outbox: [] }))
  globalThis.localStorage = storage
  globalThis.window = {
    location: { pathname: '/' },
    matchMedia: () => ({ matches: false }),
    navigator: { onLine: true, standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    confirm: () => true,
    addEventListener() {},
    removeEventListener() {},
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: globalThis.window.navigator })
  globalThis.__scorebookIntegrationReactControl.reset()
  globalThis.__scorebookIntegrationSync.outbox = []
  globalThis.__scorebookIntegrationSync.status = 'synced'
  globalThis.__scorebookIntegrationSync.lastError = null
  globalThis.__scorebookIntegrationCloudApi.softDeletes = []
  globalThis.__scorebookIntegrationCloudApi.restoreCalls = []
  globalThis.__scorebookIntegrationCloudApi.serverUpdatedAt = null
  // The follow-up SQL migration is installed: explicit application versions
  // survive the soft-delete trigger instead of being replaced by now().
  globalThis.__scorebookIntegrationCloudApi.preserveExplicitUpdatedAt = true
  let releaseDelete
  globalThis.__scorebookIntegrationCloudApi.deleteGate = new Promise((resolve) => { releaseDelete = resolve })

  globalThis.__scorebookIntegrationReactControl.begin()
  const initial = App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  const homeElement = initial.props.content.props.children[0]
  const homeTree = homeElement.type(homeElement.props)
  const gameCard = findElement(homeTree, (element) => element.type?.name === 'GameCard')
  const deleteButton = findElement(gameCard.type(gameCard.props), (element) => element.props?.['aria-label'] === 'Delete Farkle game')
  deleteButton.props.onClick()

  const deleteSync = globalThis.__scorebookIntegrationSync.syncNow()
  globalThis.__scorebookIntegrationReactControl.begin()
  const afterDelete = App()
  const toast = afterDelete.props.undoToast.type(afterDelete.props.undoToast.props)
  findElement(toast, (element) => element.type === 'button' && element.props.children === 'Undo').props.onClick()

  releaseDelete()
  await deleteSync
  await globalThis.__scorebookIntegrationSync.syncNow()

  const store = loadSyncStore()
  assert.equal(globalThis.__scorebookIntegrationCloudApi.softDeletes.length, 1)
  assert.equal(globalThis.__scorebookIntegrationCloudApi.restoreCalls.length, 1)
  assert.equal(
    globalThis.__scorebookIntegrationCloudApi.restoreCalls[0].expectedTombstones.games[0].updated_at,
    globalThis.__scorebookIntegrationCloudApi.serverUpdatedAt,
  )
  assert.equal(store.outbox.length, 0)
  assert.equal(store.lastError, null)
})

test('aborts initial migration when the cloud snapshot fails, then retries without remounting', async () => {
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
  storage.setItem('gamescorer.cloud.v1', JSON.stringify({
    initialMigrationCompleted: false,
    outbox: [],
    cache: { games: [], roster: [], activeGameId: null },
    reconciledCache: { games: [], roster: [], activeGameId: null },
    lastSyncAt: '2026-01-01T00:00:00.000Z',
  }))
  globalThis.localStorage = storage
  const listeners = new Map()
  globalThis.window = {
    location: { pathname: '/' },
    matchMedia: () => ({ matches: false }),
    navigator: { onLine: true, standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    dispatchEvent(event) { listeners.get(event.type)?.(event) },
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: globalThis.window.navigator })
  globalThis.navigator.onLine = false
  globalThis.__scorebookIntegrationReactControl.reset()
  globalThis.__scorebookIntegrationSync.outbox = []
  globalThis.__scorebookIntegrationSync.status = 'synced'
  globalThis.__scorebookIntegrationSync.lastError = null
  globalThis.__scorebookIntegrationCloudApi.mutations = []
  globalThis.__scorebookIntegrationCloudApi.failFetch = true
  globalThis.__scorebookIntegrationCloudApi.failUpsert = true

  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  let store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, false)
  assert.equal(store.lastError, null)
  assert.deepEqual(store.outbox, [])
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations, [])

  globalThis.__scorebookIntegrationCloudApi.failFetch = false
  globalThis.__scorebookIntegrationCloudApi.failUpsert = false
  globalThis.navigator.onLine = true
  globalThis.window.dispatchEvent({ type: 'online' })
  await new Promise((resolve) => setImmediate(resolve))
  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, true)
  assert.equal(store.outbox.length, 0)
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations.map(({ initialMigration }) => initialMigration), [true])
})

test('persists a failed migration for retry and completes only after replay removes it', async () => {
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
  const listeners = new Map()
  globalThis.window = {
    location: { pathname: '/' },
    matchMedia: () => ({ matches: false }),
    navigator: { onLine: true, standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    dispatchEvent(event) { listeners.get(event.type)?.(event) },
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: globalThis.window.navigator })
  globalThis.__scorebookIntegrationReactControl.reset()
  globalThis.__scorebookIntegrationSync.outbox = []
  globalThis.__scorebookIntegrationSync.status = 'synced'
  globalThis.__scorebookIntegrationSync.lastError = null
  globalThis.__scorebookIntegrationCloudApi.mutations = []
  globalThis.__scorebookIntegrationCloudApi.failFetch = false
  globalThis.__scorebookIntegrationCloudApi.failUpsert = true

  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  let store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, false)
  assert.equal(store.outbox.length, 1)
  assert.equal(store.outbox[0].initialMigration, true)
  assert.equal(store.lastError, 'migration upload unavailable')
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations, [])

  globalThis.__scorebookIntegrationCloudApi.failUpsert = false
  await globalThis.__scorebookIntegrationSync.syncNow()
  store = loadSyncStore()
  assert.equal(store.outbox.length, 0)
  assert.equal(store.lastError, null)
  assert.equal(store.initialMigrationCompleted, true)

  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, true)
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations.map(({ initialMigration }) => initialMigration), [true])
})

test('preserves a persisted migration when the snapshot fails and recognizes its replay without duplicating it', async () => {
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
  const existingMigration = {
    id: 'migration_existing',
    entity: 'scorebook',
    operation: 'upsert',
    initialMigration: true,
    payload: { rows: { people: [], games: [], gamePlayers: [], rounds: [] } },
  }
  saveSyncStore({
    cache: { games: [], roster: [], activeGameId: null },
    reconciledCache: { games: [], roster: [], activeGameId: null },
    lastSyncAt: '2026-01-01T00:00:00.000Z',
    outbox: [existingMigration],
    initialMigrationCompleted: false,
  }, storage)
  globalThis.localStorage = storage
  const listeners = new Map()
  globalThis.window = {
    location: { pathname: '/' },
    matchMedia: () => ({ matches: false }),
    navigator: { onLine: true, standalone: false, userAgent: 'test', maxTouchPoints: 0 },
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name) { listeners.delete(name) },
    dispatchEvent(event) { listeners.get(event.type)?.(event) },
  }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: globalThis.window.navigator })
  globalThis.__scorebookIntegrationReactControl.reset()
  globalThis.__scorebookIntegrationSync.outbox = [existingMigration]
  globalThis.__scorebookIntegrationSync.status = 'synced'
  globalThis.__scorebookIntegrationSync.lastError = null
  globalThis.__scorebookIntegrationCloudApi.mutations = []
  globalThis.__scorebookIntegrationCloudApi.failFetch = true
  globalThis.__scorebookIntegrationCloudApi.failUpsert = false

  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  let store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, false)
  assert.deepEqual(store.outbox.map(({ id }) => id), ['migration_existing'])
  assert.equal(store.lastError, 'snapshot unavailable')
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations, [])

  globalThis.__scorebookIntegrationCloudApi.failFetch = false
  globalThis.navigator.onLine = true
  globalThis.window.dispatchEvent({ type: 'online' })
  await new Promise((resolve) => setImmediate(resolve))
  globalThis.__scorebookIntegrationReactControl.begin()
  App()
  await globalThis.__scorebookIntegrationReactControl.flushEffects()
  await new Promise((resolve) => setImmediate(resolve))

  store = loadSyncStore()
  assert.equal(store.initialMigrationCompleted, true)
  assert.equal(store.outbox.length, 0)
  assert.deepEqual(globalThis.__scorebookIntegrationCloudApi.mutations.map(({ initialMigration }) => initialMigration), [true])
})

test('does not expose a cloud backup before the first successful sync', () => {
  const storage = new MemoryStorage()
  saveStateToCloudCache({ games: [{ id: 'g_local' }], roster: [] }, storage)
  assert.equal(loadReconciledState(storage), null)
})
