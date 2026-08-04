import test from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createCloudApi } from '../src/lib/cloudApi.js'
import { toRemoteRows, toRemoteRowsDelta } from '../src/lib/cloudState.js'
import { loadSyncStore } from '../src/lib/sync.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
}

function mutableCloudClient(initialRows) {
  const tables = Object.fromEntries(Object.entries(initialRows).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]))
  const calls = []

  return {
    calls,
    rows(table) { return tables[table] ?? [] },
    from(table) {
      let action = 'select'
      let payload = null
      const filters = []
      const query = {
        select(columns) {
          calls.push({ table, operation: 'select', columns })
          return query
        },
        order(column, options) {
          calls.push({ table, operation: 'order', column, options })
          return query
        },
        range(from, to) {
          calls.push({ table, operation: 'range', from, to })
          return query
        },
        gte(column, value) {
          calls.push({ table, operation: 'gte', column, value })
          filters.push((row) => row[column] >= value)
          return query
        },
        eq(column, value) {
          calls.push({ table, operation: 'eq', column, value })
          filters.push((row) => row[column] === value)
          return query
        },
        is(column, value) {
          calls.push({ table, operation: 'is', column, value })
          filters.push((row) => (row[column] ?? null) === value)
          return query
        },
        update(nextPayload) {
          action = 'update'
          payload = nextPayload
          calls.push({ table, operation: 'update', payload: nextPayload })
          return query
        },
        then(resolve, reject) {
          try {
            const tableRows = tables[table] ?? (tables[table] = [])
            const matches = tableRows.filter((row) => filters.every((matchesFilter) => matchesFilter(row)))
            if (action === 'update') {
              for (const row of matches) Object.assign(row, payload)
            }
            return Promise.resolve({ data: matches, error: null }).then(resolve, reject)
          } catch (error) {
            return Promise.reject(error).then(resolve, reject)
          }
        },
        upsert(rows, options) {
          action = 'upsert'
          payload = rows
          calls.push({ table, operation: 'upsert', payload: rows, options })
          return query
        },
      }
      return query
    },
  }
}

function deferred() {
  let resolve
  const promise = new Promise((value) => { resolve = value })
  return { promise, resolve }
}

function browserHarness() {
  const listeners = new Map()
  const documentListeners = new Map()
  const previous = {
    document: globalThis.document,
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
    navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'),
    addEventListener: globalThis.addEventListener,
    removeEventListener: globalThis.removeEventListener,
    window: globalThis.window,
    actEnvironment: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  const window = {
    event: { type: 'load' },
    HTMLIFrameElement: class {},
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { listeners.delete(name) },
  }
  const document = {
    nodeType: 9,
    defaultView: window,
    visibilityState: 'visible',
    addEventListener(name, listener) { documentListeners.set(name, listener) },
    removeEventListener(name, listener) { documentListeners.delete(name) },
    createElement(type) {
      const element = {
        nodeType: 1,
        nodeName: type.toUpperCase(),
        tagName: type.toUpperCase(),
        ownerDocument: document,
        children: [],
        firstChild: null,
        style: {},
        appendChild(child) { this.children.push(child); this.firstChild ??= child; return child },
        insertBefore(child) { this.children.unshift(child); this.firstChild = child; return child },
        removeChild(child) { this.children = this.children.filter((item) => item !== child); this.firstChild = this.children[0] ?? null; return child },
        addEventListener() {},
        removeEventListener() {},
        setAttribute() {},
      }
      return element
    },
    createTextNode(text) { return { nodeType: 3, nodeValue: text, ownerDocument: document } },
  }
  document.documentElement = document.createElement('html')
  document.body = document.createElement('body')
  document.activeElement = document.body
  globalThis.window = window
  globalThis.document = document
  globalThis.addEventListener = window.addEventListener
  globalThis.removeEventListener = window.removeEventListener
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() })
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  return {
    listeners,
    documentListeners,
    createContainer: () => document.createElement('div'),
    restore() {
      if (previous.document === undefined) delete globalThis.document
      else globalThis.document = previous.document
      if (previous.window === undefined) delete globalThis.window
      else globalThis.window = previous.window
      if (previous.addEventListener) globalThis.addEventListener = previous.addEventListener
      else delete globalThis.addEventListener
      if (previous.removeEventListener) globalThis.removeEventListener = previous.removeEventListener
      else delete globalThis.removeEventListener
      if (previous.localStorage) Object.defineProperty(globalThis, 'localStorage', previous.localStorage)
      else delete globalThis.localStorage
      if (previous.navigator) Object.defineProperty(globalThis, 'navigator', previous.navigator)
      else delete globalThis.navigator
      if (previous.actEnvironment === undefined) delete globalThis.IS_REACT_ACT_ENVIRONMENT
      else globalThis.IS_REACT_ACT_ENVIRONMENT = previous.actEnvironment
    },
  }
}

async function loadHook() {
  return (await import('../src/lib/useCloudSync.js')).useCloudSync
}

test('mounts the real hook, follows navigation during deferred sync, deduplicates refreshes, and cleans listeners', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const gate = deferred()
  let fetchCalls = 0
  const api = {
    fetchSnapshot() { fetchCalls += 1; return gate.promise },
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => {},
  }
  const observed = { hook: null, updates: [] }
  const setState = (state) => { observed.updates.push(state) }
  const dependencies = { configured: true, api }
  function Harness({ state }) {
    observed.hook = useCloudSync(state, setState, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness, { state: { games: [], roster: [], activeGameId: 'g_before' } })) })
    await act(async () => { root.render(React.createElement(Harness, { state: { games: [], roster: [], activeGameId: 'g_after_navigation' } })) })
    browser.listeners.get('online')()
    browser.documentListeners.get('visibilitychange')()
    assert.equal(fetchCalls, 1)

    gate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await gate.promise })

    assert.equal(observed.updates.at(-1).activeGameId, 'g_after_navigation')
    assert.equal(browser.listeners.has('online'), true)
    assert.equal(browser.documentListeners.has('visibilitychange'), true)
  } finally {
    await act(async () => { root.unmount() })
    assert.equal(browser.listeners.has('online'), false)
    assert.equal(browser.documentListeners.has('visibilitychange'), false)
    browser.restore()
  }
})

test('keeps a soft-delete mutation pending when the API rejects a zero-row update', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => { throw new Error('Supabase rounds: no rows matched') },
  }
  const dependencies = { configured: true, api }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_zero_row',
        entity: 'rounds',
        entityId: 'r_missing',
        operation: 'softDelete',
        updatedAt: '2026-01-03T00:00:00.000Z',
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.deepEqual(stored.outbox.map((mutation) => mutation.id), ['m_zero_row'])
    assert.equal(observed.hook.pendingCount, 1)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('refreshes the shared row and records a CAS conflict without keeping it pending', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const serverUpdatedAt = '2026-01-04T00:00:00.000Z'
  let snapshotCalls = 0
  const sharedRows = {
    people: [],
    games: [{
      id: 'g_conflict',
      game_id: 'farkle',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: serverUpdatedAt,
      settings: {},
      finished_at: null,
      deleted_at: null,
    }],
    gamePlayers: [],
    rounds: [],
  }
  const api = {
    fetchSnapshot: async () => { snapshotCalls += 1; return sharedRows },
    fetchRowsUpdatedSince: async () => sharedRows,
    upsertRows: async () => { throw new Error('Supabase games: stale mutation; newer remote row exists') },
    softDelete: async () => {},
  }
  const observed = { hook: null, updates: [] }
  function Harness() {
    observed.hook = useCloudSync({ activeGameId: null, games: [], roster: [] }, (nextState) => {
      observed.updates.push(nextState)
    }, { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_conflict',
        entity: 'scorebook',
        operation: 'upsert',
        payload: {
          rows: {
            people: [],
            games: [{
              id: 'g_conflict',
              game_id: 'farkle',
              created_at: '2026-01-01T00:00:00.000Z',
              updated_at: '2026-01-03T00:00:00.000Z',
              settings: {},
              finished_at: null,
              deleted_at: null,
            }],
            gamePlayers: [],
            rounds: [],
          },
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.ok(snapshotCalls >= 2)
    assert.equal(observed.hook.error, 'This was changed on another device. The shared version is now shown.')
    assert.equal(observed.hook.pendingCount, 0)
    assert.equal(observed.updates.at(-1).games[0].updatedAt, Date.parse(serverUpdatedAt))
    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.equal(stored.outbox.length, 1)
    assert.equal(stored.outbox[0].id, 'm_conflict')
    assert.equal(stored.outbox[0].status, 'conflict')
    assert.equal(stored.outbox[0].error, 'This was changed on another device. The shared version is now shown.')
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('continues replay after a CAS conflict while retaining the conflict error state', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const upsertPayloads = []
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async (rows) => {
      upsertPayloads.push(rows)
      if (upsertPayloads.length === 1) throw new Error('Supabase games: stale mutation; newer remote row exists')
      return rows
    },
    softDelete: async () => {},
  }
  const observed = { hook: null }
  function Harness() {
    observed.hook = useCloudSync({ activeGameId: null, games: [], roster: [] }, () => {}, { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_conflict_first',
        entity: 'scorebook',
        operation: 'upsert',
        payload: { rows: { people: [], games: [{ id: 'g_first', game_id: 'farkle', updated_at: '2026-01-03T00:00:00.000Z', settings: {} }], gamePlayers: [], rounds: [] } },
      })
      observed.hook.enqueueStateMutation({
        id: 'm_success_after_conflict',
        entity: 'scorebook',
        operation: 'upsert',
        payload: { rows: { people: [{ id: 'p_after', name: 'After', updated_at: '2026-01-04T00:00:00.000Z' }], games: [], gamePlayers: [], rounds: [] } },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(upsertPayloads.length, 2)
    assert.equal(upsertPayloads[1].people[0].id, 'p_after')
    assert.equal(observed.hook.error, 'This was changed on another device. The shared version is now shown.')
    assert.equal(observed.hook.pendingCount, 0)
    const stored = loadSyncStore(globalThis.localStorage)
    assert.equal(stored.outbox.length, 1)
    assert.equal(stored.outbox[0].id, 'm_conflict_first')
    assert.equal(stored.outbox[0].status, 'conflict')
    assert.equal(stored.lastError, 'This was changed on another device. The shared version is now shown.')
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('merges concurrent edits to different rounds without a stale CAS write', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const players = [{ id: 'p_one', name: 'One' }, { id: 'p_two', name: 'Two' }]
  const previousGame = {
    id: 'g_round_merge',
    gameId: 'farkle',
    createdAt: 1,
    updatedAt: 900,
    players,
    settings: { target: 10000, opening: 0 },
    rounds: [
      { id: 'r_a', updatedAt: 100, entries: { p_one: { score: 100 }, p_two: { score: 50 } } },
      { id: 'r_b', updatedAt: 1100, entries: { p_one: { score: 200 }, p_two: { score: 75 } } },
    ],
    finishedAt: null,
  }
  const localGame = {
    ...previousGame,
    updatedAt: 1300,
    rounds: [
      { id: 'r_a', updatedAt: 1300, entries: { p_one: { score: 900 }, p_two: { score: 50 } } },
      previousGame.rounds[1],
    ],
  }
  const remoteGame = {
    ...previousGame,
    updatedAt: 1400,
    finishedAt: 1500,
    rounds: [
      previousGame.rounds[0],
      { id: 'r_b', updatedAt: 1400, entries: { p_one: { score: 800 }, p_two: { score: 75 } } },
    ],
  }
  const remoteRows = () => toRemoteRows({ roster: players, games: [remoteGame] })
  const server = mutableCloudClient(remoteRows())
  const cloudApi = createCloudApi(server)
  const upsertPayloads = []
  const api = {
    fetchSnapshot: async () => remoteRows(),
    fetchRowsUpdatedSince: async () => remoteRows(),
    upsertRows: async (rows) => {
      upsertPayloads.push(rows)
      return cloudApi.upsertRows(rows)
    },
    softDelete: async (...args) => cloudApi.softDelete(...args),
  }
  const mutationRows = toRemoteRowsDelta(
    { roster: players, games: [localGame] },
    { roster: players, games: [previousGame] },
    { gameId: 'g_round_merge', includeGame: false, playerIds: [], roundIds: ['r_a'] },
  )
  const observed = { hook: null, updates: [] }
  function Harness() {
    observed.hook = useCloudSync({ activeGameId: null, roster: players, games: [localGame] }, (nextState) => {
      observed.updates.push(nextState)
    }, { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_round_merge',
        entity: 'scorebook',
        operation: 'upsert',
        payload: { rows: mutationRows },
        state: { activeGameId: null, roster: players, games: [localGame] },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(upsertPayloads.length, 1)
    assert.deepEqual(upsertPayloads[0].games, [])
    assert.deepEqual(upsertPayloads[0].rounds.map((round) => round.id), ['r_a'])
    assert.equal(observed.hook.error, null)
    assert.equal(observed.hook.pendingCount, 0)
    assert.deepEqual(server.rows('rounds').find((round) => round.id === 'r_a').entries, localGame.rounds[0].entries)
    assert.deepEqual(server.rows('rounds').find((round) => round.id === 'r_b').entries, remoteGame.rounds[1].entries)
    const merged = observed.updates.at(-1).games[0]
    assert.deepEqual(merged.rounds.map((round) => [round.id, round.entries]).sort(([left], [right]) => left.localeCompare(right)), [
      ['r_a', localGame.rounds[0].entries],
      ['r_b', remoteGame.rounds[1].entries],
    ])
    assert.equal(merged.finishedAt, 1500)
    const stored = loadSyncStore(globalThis.localStorage)
    assert.deepEqual(stored.reconciledCache.games[0].rounds.find((round) => round.id === 'r_a').entries, localGame.rounds[0].entries)
    assert.deepEqual(toRemoteRows(stored.reconciledCache).rounds.find((round) => round.id === 'r_a').entries, localGame.rounds[0].entries)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('keeps a successful local delete tombstoned after remote merge and replay', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const gate = deferred()
  const updates = []
  let deleted = 0
  const clientUpdatedAt = '2026-01-03T00:00:00.000Z'
  const serverUpdatedAt = '2026-01-03T00:00:01.000Z'
  const api = {
    fetchSnapshot: async () => gate.promise,
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => {
      deleted += 1
      return { id: 'g_delete', updated_at: serverUpdatedAt, deleted_at: clientUpdatedAt }
    },
  }
  const dependencies = { configured: true, api }
  const observed = { value: null }
  const setState = (nextState) => { updates.push(nextState) }
  function Harness({ state }) {
    observed.value = useCloudSync(state, setState, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness, {
      state: {
        activeGameId: 'g_delete',
        roster: [{ id: 'p_one', name: 'One' }],
        games: [{ id: 'g_delete', gameId: 'farkle', players: [], rounds: [], settings: {} }],
      },
    })) })
    await act(async () => { root.render(React.createElement(Harness, {
      state: { activeGameId: null, roster: [{ id: 'p_one', name: 'One' }], games: [] },
    })) })
    await act(async () => {
      observed.value.enqueueStateMutation({
        id: 'm_delete', entity: 'games', entityId: 'g_delete', operation: 'softDelete',
        updatedAt: clientUpdatedAt,
      })
    })

    gate.resolve({
      people: [{ id: 'p_one', name: 'One', updated_at: '2026-01-01T00:00:00.000Z' }],
      games: [{ id: 'g_delete', game_id: 'farkle', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }],
      gamePlayers: [], rounds: [],
    })
    await act(async () => { await gate.promise; await new Promise((resolve) => setTimeout(resolve, 0)) })

    assert.equal(deleted, 1)
    assert.deepEqual(updates.at(-1).games, [])
    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.equal(stored.cache.__cloudMetadata.games[0].id, 'g_delete')
    assert.equal(stored.cache.__cloudMetadata.games[0].updatedAt, Date.parse(serverUpdatedAt))
    assert.equal(stored.cache.__cloudMetadata.games[0].deletedAt, clientUpdatedAt)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('applies canonical upsert response metadata to local state immediately', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const updates = []
  const clientUpdatedAt = '2026-01-03T00:00:00.000Z'
  const serverUpdatedAt = '2026-01-03T00:00:01.000Z'
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => ({
      people: [{ id: 'p_server', name: 'Server Name', updated_at: serverUpdatedAt, deleted_at: null }],
      games: [], gamePlayers: [], rounds: [],
    }),
    softDelete: async () => {},
  }
  const observed = { hook: null }
  const setState = (state) => { updates.push(state) }
  function Harness() {
    observed.hook = useCloudSync({
      activeGameId: 'g_active',
      roster: [{ id: 'p_server', name: 'Server Name', updatedAt: Date.parse(clientUpdatedAt) }],
      games: [],
    }, setState, { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_server_timestamp', operation: 'upsert', entity: 'people',
        payload: { rows: { people: [{
          id: 'p_server', name: 'Server Name', updated_at: clientUpdatedAt, deleted_at: null,
        }] } },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(updates.at(-1).activeGameId, 'g_active')
    assert.equal(updates.at(-1).roster[0].updatedAt, Date.parse(serverUpdatedAt))
    assert.equal(JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1')).outbox.length, 0)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('merges a canonical round-only response into the reconciled parent game', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const serverUpdatedAt = '2026-01-04T00:00:00.000Z'
  const localState = {
    activeGameId: 'g_round_response',
    roster: [],
    games: [{
      id: 'g_round_response',
      gameId: 'farkle',
      createdAt: 1,
      updatedAt: 100,
      players: [],
      settings: {},
      rounds: [{ id: 'r_response', updatedAt: 200, entries: { p_one: { score: 10 } } }],
      finishedAt: null,
    }],
  }
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => ({
      people: [],
      games: [],
      gamePlayers: [],
      rounds: [{
        id: 'r_response',
        game_id: 'g_round_response',
        round_index: 0,
        entries: { p_one: { score: 42 } },
        updated_at: serverUpdatedAt,
        deleted_at: null,
      }],
    }),
    softDelete: async () => {},
  }
  const observed = { hook: null, updates: [] }
  function Harness() {
    observed.hook = useCloudSync(localState, (nextState) => observed.updates.push(nextState), { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_round_response',
        entity: 'scorebook',
        operation: 'upsert',
        state: localState,
        payload: { rows: { people: [], games: [], gamePlayers: [], rounds: [] } },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    assert.equal(observed.updates.at(-1).games[0].rounds[0].entries.p_one.score, 42)
    const stored = loadSyncStore(globalThis.localStorage)
    assert.equal(stored.reconciledCache.games[0].id, 'g_round_response')
    assert.equal(stored.reconciledCache.games[0].rounds[0].entries.p_one.score, 42)
    assert.equal(toRemoteRows(stored.reconciledCache).rounds[0].entries.p_one.score, 42)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('automatically retries a failed replay with bounded backoff', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const firstReplayStarted = deferred()
  const releaseFirstReplay = deferred()
  let upsertCalls = 0
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {
      upsertCalls += 1
      if (upsertCalls === 1) {
        firstReplayStarted.resolve()
        await releaseFirstReplay.promise
        throw new Error('temporary network failure')
      }
      return { people: [], games: [], gamePlayers: [], rounds: [] }
    },
    softDelete: async () => {},
  }
  const observed = { hook: null }
  const setState = () => {}
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, setState, {
      configured: true, api,
    })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_retry', operation: 'upsert', entity: 'people',
        payload: { rows: { people: [{ id: 'p_retry', name: 'Retry', updated_at: '2026-01-03T00:00:00.000Z' }] } },
      })
      await firstReplayStarted.promise
    })
    releaseFirstReplay.resolve()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)) })
    assert.equal(upsertCalls, 1)
    const failedStore = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.equal(failedStore.outbox.length, 1)
    assert.equal(failedStore.lastError, 'temporary network failure')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 150)) })

    assert.equal(upsertCalls, 2)
    assert.equal(observed.hook.pendingCount, 0)
    assert.equal(JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1')).outbox.length, 0)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('schedules one follow-up replay for a mutation added during replay', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const firstReplay = deferred()
  const replayStarted = deferred()
  const rowsSent = []
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async (rows) => {
      rowsSent.push(rows)
      if (rowsSent.length === 1) {
        replayStarted.resolve()
        await firstReplay.promise
      }
    },
    softDelete: async () => {},
  }
  const observed = { value: null }
  const setState = () => {}
  const dependencies = { configured: true, api }
  function Harness() {
    observed.value = useCloudSync({ games: [], roster: [], activeGameId: null }, setState, dependencies)
    return null
  }
  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => {
      observed.value.enqueueStateMutation({
        id: 'm_first', operation: 'upsert', entity: 'people',
        payload: { rows: { people: [{ id: 'p_first', name: 'First', updated_at: '2026-01-01T00:00:00.000Z' }] } },
      })
      await replayStarted.promise
    })
    assert.equal(rowsSent.length, 1)
    await act(async () => {
      observed.value.enqueueStateMutation({
        id: 'm_second', operation: 'upsert', entity: 'people',
        payload: { rows: { people: [{ id: 'p_second', name: 'Second', updated_at: '2026-01-02T00:00:00.000Z' }] } },
      })
    })
    firstReplay.resolve()
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

    assert.equal(rowsSent.length, 2)
    assert.equal(rowsSent[1].people[0].id, 'p_second')
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('keeps a scalar round tombstone after local removal and successful replay', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const gate = deferred()
  const updates = []
  let deleteArgs = null
  const api = {
    fetchSnapshot: async () => gate.promise,
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async (...args) => {
      deleteArgs = args
      return {
        id: 'r_removed', game_id: 'g_round', round_index: 0,
        entries: { p_one: { score: 1 } },
        updated_at: '2026-01-04T00:00:00.000Z',
        deleted_at: '2026-01-03T00:00:00.000Z',
      }
    },
  }
  const dependencies = { configured: true, api }
  const observed = { value: null }
  const setState = (nextState) => { updates.push(nextState) }
  function Harness({ state }) {
    observed.value = useCloudSync(state, setState, dependencies)
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness, {
      state: {
        activeGameId: 'g_round', roster: [], games: [{
          id: 'g_round', gameId: 'farkle', players: [], settings: {},
          rounds: [{ id: 'r_removed', roundIndex: 0, entries: { p_one: { score: 1 } } }],
        }],
      },
    })) })
    await act(async () => { root.render(React.createElement(Harness, {
      state: {
        activeGameId: 'g_round', roster: [], games: [{
          id: 'g_round', gameId: 'farkle', players: [], settings: {}, rounds: [],
        }],
      },
    })) })
    await act(async () => {
      observed.value.enqueueStateMutation({
        id: 'm_round_delete', entity: 'rounds', entityId: 'r_removed', operation: 'softDelete',
        updatedAt: '2026-01-03T00:00:00.000Z',
        payload: {
          gameId: 'g_round', roundIndex: 0, entries: { p_one: { score: 1 } },
        },
      })
    })

    gate.resolve({
      people: [],
      games: [{ id: 'g_round', game_id: 'farkle', updated_at: '2026-01-01T00:00:00.000Z', settings: {} }],
      gamePlayers: [],
      rounds: [{
        id: 'r_removed', game_id: 'g_round', round_index: 0, entries: { p_one: { score: 1 } },
        updated_at: '2026-01-01T00:00:00.000Z',
      }],
    })
    await act(async () => { await gate.promise; await new Promise((resolve) => setTimeout(resolve, 0)) })

    assert.deepEqual(updates.at(-1).games[0].rounds, [])
    assert.deepEqual(deleteArgs.slice(0, 2), ['rounds', 'r_removed'])
    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.equal(stored.cache.__cloudMetadata.rounds[0].id, 'r_removed')
    assert.equal(stored.cache.__cloudMetadata.rounds[0].gameId, 'g_round')
    assert.equal(stored.cache.__cloudMetadata.rounds[0].roundIndex, 0)
    assert.deepEqual(stored.cache.__cloudMetadata.rounds[0].entries, { p_one: { score: 1 } })
    assert.deepEqual(toRemoteRows(loadSyncStore(globalThis.localStorage).cache).rounds, [{
      id: 'r_removed', game_id: 'g_round', round_index: 0, entries: { p_one: { score: 1 } },
      updated_at: '2026-01-04T00:00:00.000Z', deleted_at: '2026-01-03T00:00:00.000Z',
    }])
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('replays a composite game player tombstone through cloudApi and persists cache metadata', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const updatedAt = '2026-01-03T00:00:00.000Z'
  const existingUpdatedAt = '2026-01-01T00:00:00.000Z'
  const client = mutableCloudClient({
    people: [
      { id: 'p_keep', name: 'Keep', updated_at: existingUpdatedAt, deleted_at: null },
      { id: 'p_remove', name: 'Remove', updated_at: existingUpdatedAt, deleted_at: null },
    ],
    games: [{
      id: 'g_players', game_id: 'farkle', created_at: existingUpdatedAt,
      updated_at: existingUpdatedAt, finished_at: null, settings: {}, deleted_at: null,
    }],
    game_players: [
      { game_id: 'g_players', person_id: 'p_keep', seat_order: 0, name_snapshot: 'Keep', updated_at: existingUpdatedAt, deleted_at: null },
      { game_id: 'g_players', person_id: 'p_remove', seat_order: 1, name_snapshot: 'Remove', updated_at: existingUpdatedAt, deleted_at: null },
    ],
    rounds: [],
  })
  const api = createCloudApi(client)
  const updates = []
  const observed = { hook: null }
  const state = {
    activeGameId: 'g_players',
    roster: [{ id: 'p_keep', name: 'Keep' }, { id: 'p_remove', name: 'Remove' }],
    games: [{
      id: 'g_players', gameId: 'farkle', createdAt: Date.parse(existingUpdatedAt),
      updatedAt: Date.parse(existingUpdatedAt),
      players: [{ id: 'p_keep', name: 'Keep' }, { id: 'p_remove', name: 'Remove' }],
      settings: {}, rounds: [], finishedAt: null,
    }],
  }
  function Harness() {
    observed.hook = useCloudSync(state, (nextState) => updates.push(nextState), { configured: true, api })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

    await act(async () => {
      observed.hook.enqueueStateMutation({
        id: 'm_player_remove',
        entity: 'game_players',
        entityId: { gameId: 'g_players', personId: 'p_remove' },
        operation: 'softDelete',
        updatedAt,
        payload: {
          gameId: 'g_players',
          personId: 'p_remove',
          seatOrder: 1,
          nameSnapshot: 'Remove',
        },
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const playerEqCalls = client.calls
      .filter((call) => call.table === 'game_players' && call.operation === 'eq')
      .map((call) => [call.column, call.value])
    assert.deepEqual(playerEqCalls, [
      ['game_id', 'g_players'],
      ['person_id', 'p_remove'],
      ['game_id', 'g_players'],
      ['person_id', 'p_remove'],
      ['updated_at', existingUpdatedAt],
    ])
    assert.deepEqual(client.calls.find((call) => call.table === 'game_players' && call.operation === 'update'), {
      table: 'game_players',
      operation: 'update',
      payload: { deleted_at: updatedAt, updated_at: updatedAt },
    })
    assert.deepEqual(client.rows('game_players').find((row) => row.person_id === 'p_remove'), {
      game_id: 'g_players',
      person_id: 'p_remove',
      seat_order: 1,
      name_snapshot: 'Remove',
      updated_at: updatedAt,
      deleted_at: updatedAt,
    })

    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.deepEqual(stored.outbox, [])
    assert.deepEqual(stored.cache.games[0].players, [{ id: 'p_keep', name: 'Keep' }])
    assert.deepEqual(stored.cache.__cloudMetadata.gamePlayers, [{
      gameId: 'g_players',
      id: 'p_remove',
      seatOrder: 1,
      nameSnapshot: 'Remove',
      updatedAt: Date.parse(updatedAt),
      deletedAt: updatedAt,
    }])
    assert.equal(loadSyncStore(globalThis.localStorage).outbox.length, 0)
    assert.equal(updates.at(-1).games[0].players.some((player) => player.id === 'p_remove'), false)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('mounts the hook safely in local mode when cloud is not configured', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  let hook
  function Harness() {
    hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {})
    return null
  }
  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    assert.equal(hook.status, 'local')
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('caches an immediately queued next state before React renders it', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const gate = deferred()
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => gate.promise,
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {},
    softDelete: async () => {},
  }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, {
      configured: true,
      api,
    })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    const nextState = {
      activeGameId: 'g_local',
      roster: [{ id: 'p_one', name: 'One' }],
      games: [],
    }
    observed.hook.enqueueStateMutation({
      id: 'm_next_state',
      entity: 'scorebook',
      operation: 'upsert',
      state: nextState,
      payload: { rows: toRemoteRows(nextState) },
    })

    const stored = JSON.parse(globalThis.localStorage.getItem('gamescorer.cloud.v1'))
    assert.deepEqual(stored.cache.roster, nextState.roster)
    assert.equal(stored.cache.activeGameId, 'g_local')
    gate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await gate.promise })
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('retains migration completion when a later mutation commits the store', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const replayGate = deferred()
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => replayGate.promise,
    softDelete: async () => {},
  }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, {
      configured: true,
      api,
    })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    observed.hook.updateSyncStore({ initialMigrationCompleted: true })
    observed.hook.enqueueStateMutation({
      id: 'm_after_migration',
      entity: 'scorebook',
      operation: 'upsert',
      state: { games: [], roster: [{ id: 'p_one', name: 'One' }], activeGameId: null },
      payload: { rows: { people: [], games: [], gamePlayers: [], rounds: [] } },
    })

    assert.equal(loadSyncStore(globalThis.localStorage).initialMigrationCompleted, true)
    replayGate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await replayGate.promise })
    assert.equal(loadSyncStore(globalThis.localStorage).initialMigrationCompleted, true)
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('keeps cloud backup state reconciled while an optimistic mutation is pending', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const replayStarted = deferred()
  const replayGate = deferred()
  const remoteRows = {
    people: [],
    games: [{
      id: 'g_remote',
      game_id: 'farkle',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      settings: {},
    }],
    gamePlayers: [],
    rounds: [],
  }
  const optimisticState = {
    activeGameId: null,
    roster: [],
    games: [
      { id: 'g_remote', gameId: 'farkle', createdAt: Date.parse('2026-01-01T00:00:00.000Z'), updatedAt: Date.parse('2026-01-01T00:00:00.000Z'), players: [], settings: {}, rounds: [], finishedAt: null },
      { id: 'g_local', gameId: 'farkle', createdAt: Date.now(), updatedAt: Date.now(), players: [], settings: {}, rounds: [], finishedAt: null },
    ],
  }
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => remoteRows,
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => {
      replayStarted.resolve()
      return replayGate.promise
    },
    softDelete: async () => {},
  }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, {
      configured: true,
      api,
    })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    observed.hook.enqueueStateMutation({
      id: 'm_optimistic_backup',
      entity: 'scorebook',
      operation: 'upsert',
      state: optimisticState,
      payload: { rows: toRemoteRows(optimisticState) },
    })
    await act(async () => { await replayStarted.promise })

    const stored = loadSyncStore(globalThis.localStorage)
    assert.deepEqual(stored.cache.games.map((game) => game.id).sort(), ['g_local', 'g_remote'])
    assert.deepEqual(stored.reconciledCache.games.map((game) => game.id), ['g_remote'])
    replayGate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await replayGate.promise })
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})

test('cancels pending migration mutations before keeping local history', async () => {
  const browser = browserHarness()
  const useCloudSync = await loadHook()
  const replayGate = deferred()
  const observed = { hook: null }
  const api = {
    fetchSnapshot: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    fetchRowsUpdatedSince: async () => ({ people: [], games: [], gamePlayers: [], rounds: [] }),
    upsertRows: async () => replayGate.promise,
    softDelete: async () => {},
  }
  function Harness() {
    observed.hook = useCloudSync({ games: [], roster: [], activeGameId: null }, () => {}, {
      configured: true,
      api,
    })
    return null
  }

  const root = createRoot(browser.createContainer())
  try {
    await act(async () => { root.render(React.createElement(Harness)) })
    observed.hook.enqueueStateMutation({
      id: 'm_initial_migration',
      entity: 'scorebook',
      operation: 'upsert',
      initialMigration: true,
      payload: { rows: { people: [], games: [], gamePlayers: [], rounds: [] } },
    })
    observed.hook.cancelSyncMutations((mutation) => mutation.initialMigration)
    observed.hook.updateSyncStore({ initialMigrationCompleted: true })

    const stored = loadSyncStore(globalThis.localStorage)
    assert.deepEqual(stored.outbox, [])
    assert.equal(stored.initialMigrationCompleted, true)
    replayGate.resolve({ people: [], games: [], gamePlayers: [], rounds: [] })
    await act(async () => { await replayGate.promise })
    assert.deepEqual(loadSyncStore(globalThis.localStorage).outbox, [])
  } finally {
    await act(async () => { root.unmount() })
    browser.restore()
  }
})
