import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enqueueMutation,
  loadSyncStore,
  mergeRemoteState,
  removeMutation,
  saveSyncStore,
} from '../src/lib/sync.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) {
    return this.#values.get(key) ?? null
  }

  setItem(key, value) {
    this.#values.set(key, String(value))
  }
}

test('loads safe defaults for missing and invalid sync data', () => {
  const storage = new MemoryStorage()
  assert.deepEqual(loadSyncStore(storage), {
    cache: { games: [], roster: [], activeGameId: null },
    outbox: [],
    lastSyncAt: null,
    lastError: null,
    initialMigrationCompleted: false,
  })

  storage.setItem('gamescorer.cloud.v1', '{not json')
  assert.deepEqual(loadSyncStore(storage).outbox, [])
  assert.equal(loadSyncStore(storage).lastError, null)
})

test('enqueues and removes mutations without mutating inputs or duplicating IDs', () => {
  const store = loadSyncStore(new MemoryStorage())
  const mutation = { id: 'm_one', entity: 'games', entityId: 'g_one', operation: 'upsert', payload: { score: 1 }, createdAt: 100 }
  const next = enqueueMutation(store, mutation)

  assert.deepEqual(store.outbox, [])
  assert.deepEqual(next.outbox, [mutation])
  assert.deepEqual(enqueueMutation(next, { ...mutation, payload: { score: 2 } }).outbox, [mutation])
  assert.deepEqual(removeMutation(next, 'm_one').outbox, [])
  assert.deepEqual(next.outbox, [mutation])
})

test('retains failed replay data and its error in persistent storage', () => {
  const storage = new MemoryStorage()
  const mutation = { id: 'm_failed', entity: 'rounds', entityId: 'r_one', operation: 'upsert', payload: {}, createdAt: 100 }
  const store = enqueueMutation(loadSyncStore(storage), mutation)
  saveSyncStore({ ...store, lastError: 'network unavailable' }, storage)

  const reloaded = loadSyncStore(storage)
  assert.deepEqual(reloaded.outbox, [mutation])
  assert.equal(reloaded.lastError, 'network unavailable')
})

test('merges by entity timestamps, applies newer tombstones, and keeps local active game', () => {
  const local = {
    activeGameId: 'g_local',
    roster: [
      { id: 'p_one', name: 'Local One', updatedAt: 100 },
      { id: 'p_old', name: 'Keep Local', updatedAt: 500 },
      { id: 'p_deleted', name: 'Remove Me', updatedAt: 100 },
    ],
    games: [
      {
        id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 100,
        players: [{ id: 'p_one', name: 'Local One' }, { id: 'p_old', name: 'Keep Local' }],
        settings: { target: 100 }, rounds: [
          { id: 'r_one', updatedAt: 100, entries: { p_one: { score: 1 } } },
          { id: 'r_local', updatedAt: 500, entries: { p_one: { score: 5 } } },
        ], finishedAt: null,
      },
      {
        id: 'g_old_tombstone', gameId: 'farkle', createdAt: 100, updatedAt: 500,
        players: [], settings: {}, rounds: [], finishedAt: null,
      },
      {
        id: 'g_new_tombstone', gameId: 'farkle', createdAt: 100, updatedAt: 100,
        players: [], settings: {}, rounds: [], finishedAt: null,
      },
    ],
  }
  const remote = {
    activeGameId: 'g_remote',
    roster: [
      { id: 'p_one', name: 'Remote One', updatedAt: 200 },
      { id: 'p_old', name: 'Stale Remote', updatedAt: 400 },
      { id: 'p_deleted', name: 'Remove Me', updatedAt: 200, deletedAt: 200 },
      { id: 'p_new', name: 'New Remote', updatedAt: 200 },
    ],
    games: [
      {
        id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 200,
        players: [
          { id: 'p_one', name: 'Remote One', updatedAt: 200 },
          { id: 'p_old', name: 'Keep Local', updatedAt: 200, deletedAt: 200 },
          { id: 'p_new', name: 'New Remote', updatedAt: 200 },
        ],
        settings: { target: 200 }, rounds: [
          { id: 'r_one', updatedAt: 200, entries: { p_one: { score: 2 } } },
          { id: 'r_deleted', updatedAt: 200, entries: {}, deletedAt: 200 },
        ], finishedAt: null,
      },
      {
        id: 'g_old_tombstone', gameId: 'farkle', createdAt: 100, updatedAt: 400,
        players: [], settings: {}, rounds: [], finishedAt: null, deletedAt: 400,
      },
      {
        id: 'g_new_tombstone', gameId: 'farkle', createdAt: 100, updatedAt: 300,
        players: [], settings: {}, rounds: [], finishedAt: null, deletedAt: 300,
      },
    ],
  }

  const merged = mergeRemoteState(local, remote, 200)
  assert.equal(merged.activeGameId, 'g_local')
  assert.deepEqual(merged.roster, [
    { id: 'p_one', name: 'Remote One', updatedAt: 200 },
    { id: 'p_old', name: 'Keep Local', updatedAt: 500 },
    { id: 'p_new', name: 'New Remote', updatedAt: 200 },
  ])
  assert.deepEqual(merged.games.map((game) => game.id), ['g_one', 'g_old_tombstone'])
  assert.deepEqual(merged.games[0], {
    id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 200,
    players: [
      { id: 'p_one', name: 'Remote One', updatedAt: 200 },
      { id: 'p_new', name: 'New Remote', updatedAt: 200 },
    ],
    settings: { target: 200 },
    rounds: [
      { id: 'r_one', updatedAt: 200, entries: { p_one: { score: 2 } } },
      { id: 'r_local', updatedAt: 500, entries: { p_one: { score: 5 } } },
    ],
    finishedAt: null,
  })
})

test('saveSyncStore writes the cloud key without affecting the legacy key', () => {
  const storage = new MemoryStorage()
  storage.setItem('gamescorer.v1', JSON.stringify({ games: [{ id: 'legacy' }], roster: [] }))
  saveSyncStore(loadSyncStore(storage), storage)

  assert.match(storage.getItem('gamescorer.cloud.v1'), /initialMigrationCompleted/)
  assert.deepEqual(JSON.parse(storage.getItem('gamescorer.v1')), { games: [{ id: 'legacy' }], roster: [] })
})
