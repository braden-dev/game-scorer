import test from 'node:test'
import assert from 'node:assert/strict'
import { fromRemoteRows, hasCloudMetadata, toRemoteRows } from '../src/lib/cloudState.js'
import { loadState, saveState } from '../src/lib/storage.js'
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

test('recognizes a valid cache containing only tombstone metadata', () => {
  const storage = new MemoryStorage()
  const cache = fromRemoteRows({
    people: [{
      id: 'p_deleted', name: 'Deleted', updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-01-02T00:00:00.000Z',
    }],
    games: [{
      id: 'g_deleted', game_id: 'farkle', updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-01-02T00:00:00.000Z', settings: {},
    }],
    gamePlayers: [],
    rounds: [],
  }, 'g_local')
  saveSyncStore({
    cache,
    outbox: [],
    lastSyncAt: null,
    lastError: null,
    initialMigrationCompleted: false,
  }, storage)

  const reloaded = loadSyncStore(storage).cache
  assert.deepEqual(reloaded.games, [])
  assert.deepEqual(reloaded.roster, [])
  assert.equal(reloaded.activeGameId, 'g_local')
  assert.equal(hasCloudMetadata(reloaded), true)
  assert.equal(reloaded[Symbol.for('gamescorer.cloudMetadata')].roster[0].deletedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(reloaded[Symbol.for('gamescorer.cloudMetadata')].games[0].deletedAt, '2026-01-02T00:00:00.000Z')
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

test('tolerates a throwing default storage getter for legacy and cloud storage', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  assert.equal(descriptor?.configurable ?? true, true)
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage unavailable')
    },
  })

  try {
    assert.doesNotThrow(() => loadState())
    assert.doesNotThrow(() => saveState({ games: [], roster: [], activeGameId: null }))
    assert.doesNotThrow(() => loadSyncStore())
    assert.doesNotThrow(() => saveSyncStore(loadSyncStore()))
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor)
    else delete globalThis.localStorage
  }
})

test('honors remote tombstones through the row adapter and state merge', () => {
  const local = {
    activeGameId: 'g_deleted',
    roster: [
      { id: 'p_deleted', name: 'Deleted Person', updatedAt: 100 },
      { id: 'p_live', name: 'Live Person', updatedAt: 100 },
    ],
    games: [
      {
        id: 'g_deleted', gameId: 'farkle', createdAt: 100, updatedAt: 100,
        players: [{ id: 'p_deleted', name: 'Deleted Person' }], settings: {},
        rounds: [{ id: 'r_deleted', entries: { p_deleted: { score: 1 } } }], finishedAt: null,
      },
      {
        id: 'g_live', gameId: 'farkle', createdAt: 100, updatedAt: 100,
        players: [{ id: 'p_live', name: 'Live Person' }], settings: {},
        rounds: [{ id: 'r_live', entries: { p_live: { score: 1 } } }], finishedAt: null,
      },
    ],
  }
  const remote = fromRemoteRows({
    people: [
      { id: 'p_deleted', name: 'Deleted Person', updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z' },
      { id: 'p_live', name: 'Live Person', updated_at: '1970-01-01T00:00:00.200Z' },
    ],
    games: [
      { id: 'g_deleted', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z', settings: {} },
      { id: 'g_live', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.200Z', settings: {} },
    ],
    gamePlayers: [
      { game_id: 'g_deleted', person_id: 'p_deleted', seat_order: 0, name_snapshot: 'Deleted Person', updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z' },
      { game_id: 'g_live', person_id: 'p_live', seat_order: 0, name_snapshot: 'Live Person', updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z' },
    ],
    rounds: [
      { id: 'r_deleted', game_id: 'g_deleted', round_index: 0, entries: {}, updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z' },
      { id: 'r_live', game_id: 'g_live', round_index: 0, entries: {}, updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.200Z' },
    ],
  })

  const merged = mergeRemoteState(local, remote, 200)
  assert.deepEqual(merged.roster, [{ id: 'p_live', name: 'Live Person' }])
  assert.deepEqual(merged.games.map((game) => game.id), ['g_live'])
  assert.deepEqual(merged.games[0].players, [])
  assert.deepEqual(merged.games[0].rounds, [])
  assert.equal(merged.activeGameId, 'g_deleted')
})

test('uses parent versions for missing local child timestamps and preserves newer local children', () => {
  const local = {
    activeGameId: 'g_one',
    roster: [],
    games: [{
      id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 500,
      players: [{ id: 'p_one', name: 'Local Player' }], settings: { target: 100 },
      rounds: [
        { id: 'r_missing', entries: { p_one: { score: 10 } } },
        { id: 'r_newer', updatedAt: 700, entries: { p_one: { score: 70 } } },
      ], finishedAt: null,
    }],
  }
  const remote = fromRemoteRows({
    people: [{ id: 'p_one', name: 'Remote Player', updated_at: '1970-01-01T00:00:00.200Z' }],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.800Z', settings: { target: 200 } }],
    gamePlayers: [{ game_id: 'g_one', person_id: 'p_one', seat_order: 0, name_snapshot: 'Remote Player', updated_at: '1970-01-01T00:00:00.200Z' }],
    rounds: [
      { id: 'r_missing', game_id: 'g_one', round_index: 0, entries: { p_one: { score: 20 } }, updated_at: '1970-01-01T00:00:00.200Z' },
      { id: 'r_newer', game_id: 'g_one', round_index: 1, entries: { p_one: { score: 80 } }, updated_at: '1970-01-01T00:00:00.600Z' },
    ],
  })

  const merged = mergeRemoteState(local, remote, 800)
  assert.deepEqual(merged.games[0].players[0], { id: 'p_one', name: 'Local Player' })
  assert.deepEqual(merged.games[0].rounds, [
    { id: 'r_missing', entries: { p_one: { score: 10 } } },
    { id: 'r_newer', updatedAt: 700, entries: { p_one: { score: 70 } } },
  ])
})

test('applies child-only updates and deletions when the parent game row is absent', () => {
  const local = {
    activeGameId: 'g_incremental',
    roster: [{ id: 'p_one', name: 'One' }],
    games: [{
      id: 'g_incremental', gameId: 'farkle', createdAt: 100, updatedAt: 100,
      players: [{ id: 'p_one', name: 'Old One' }], settings: {},
      rounds: [{ id: 'r_one', entries: { p_one: { score: 1 } } }], finishedAt: null,
    }],
  }
  const update = fromRemoteRows({
    people: [
      { id: 'p_one', name: 'One', updated_at: '1970-01-01T00:00:00.200Z' },
      { id: 'p_new', name: 'Current New', updated_at: '1970-01-01T00:00:00.250Z' },
    ],
    games: [],
    gamePlayers: [
      { game_id: 'g_incremental', person_id: 'p_one', seat_order: 3, name_snapshot: 'New One', updated_at: '1970-01-01T00:00:00.200Z' },
      { game_id: 'g_incremental', person_id: 'p_new', seat_order: 0, name_snapshot: 'Original New', updated_at: '1970-01-01T00:00:00.250Z' },
    ],
    rounds: [
      { id: 'r_one', game_id: 'g_incremental', round_index: 3, entries: { p_one: { score: 2 } }, updated_at: '1970-01-01T00:00:00.200Z' },
      { id: 'r_new', game_id: 'g_incremental', round_index: 0, entries: { p_one: { score: 4 } }, updated_at: '1970-01-01T00:00:00.250Z' },
    ],
  })
  const updated = mergeRemoteState(local, update, 200)
  assert.deepEqual(updated.games[0].players, [
    { id: 'p_new', name: 'Current New' },
    { id: 'p_one', name: 'One' },
  ])
  assert.deepEqual(updated.games[0].rounds, [
    { id: 'r_new', entries: { p_one: { score: 4 } } },
    { id: 'r_one', entries: { p_one: { score: 2 } } },
  ])
  const uploaded = toRemoteRows(updated)
  assert.deepEqual(uploaded.gamePlayers.find((player) => player.person_id === 'p_new'), {
    game_id: 'g_incremental', person_id: 'p_new', seat_order: 0, name_snapshot: 'Original New',
    updated_at: '1970-01-01T00:00:00.250Z', deleted_at: null,
  })
  assert.deepEqual(uploaded.rounds.find((round) => round.id === 'r_new'), {
    id: 'r_new', game_id: 'g_incremental', round_index: 0,
    entries: { p_one: { score: 4 } }, updated_at: '1970-01-01T00:00:00.250Z', deleted_at: null,
  })

  const deletion = fromRemoteRows({
    people: [],
    games: [],
    gamePlayers: [{ game_id: 'g_incremental', person_id: 'p_one', seat_order: 0, name_snapshot: 'New One', updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z' }],
    rounds: [{ id: 'r_one', game_id: 'g_incremental', round_index: 0, entries: {}, updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z' }],
  })
  const deleted = mergeRemoteState(updated, deletion, 300)
  assert.deepEqual(deleted.games[0].players, [{ id: 'p_new', name: 'Current New' }])
  assert.deepEqual(deleted.games[0].rounds, [{ id: 'r_new', entries: { p_one: { score: 4 } } }])
})

test('persists cloud child versions and tombstones through a sync-store round trip', () => {
  const storage = new MemoryStorage()
  const remote = fromRemoteRows({
    people: [{ id: 'p_deleted', name: 'Deleted', updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z' }],
    games: [{ id: 'g_deleted', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z', settings: {} }],
    gamePlayers: [],
    rounds: [],
  })
  const childVersion = fromRemoteRows({
    people: [{ id: 'p_one', name: 'Remote One', updated_at: '1970-01-01T00:00:00.200Z' }],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.800Z', settings: {} }],
    gamePlayers: [{ game_id: 'g_one', person_id: 'p_one', seat_order: 0, name_snapshot: 'Remote One', updated_at: '1970-01-01T00:00:00.200Z' }],
    rounds: [{ id: 'r_one', game_id: 'g_one', round_index: 0, entries: { p_one: { score: 2 } }, updated_at: '1970-01-01T00:00:00.200Z' }],
  })
  const cache = mergeRemoteState(remote, childVersion, 800)
  saveSyncStore({ cache: mergeRemoteState(cache, remote, 300), outbox: [], lastSyncAt: null, lastError: null, initialMigrationCompleted: false }, storage)
  const reloaded = loadSyncStore(storage).cache

  const local = {
    activeGameId: 'g_deleted',
    roster: [{ id: 'p_deleted', name: 'Deleted', updatedAt: 100 }],
    games: [
      { id: 'g_deleted', gameId: 'farkle', createdAt: 100, updatedAt: 100, players: [], settings: {}, rounds: [], finishedAt: null },
      { id: 'g_one', gameId: 'farkle', createdAt: 100, updatedAt: 500, players: [{ id: 'p_one', name: 'Local One' }], settings: {}, rounds: [{ id: 'r_one', entries: { p_one: { score: 1 } } }], finishedAt: null },
    ],
  }
  const merged = mergeRemoteState(local, reloaded, 800)
  assert.deepEqual(merged.roster, [{ id: 'p_one', name: 'Remote One' }])
  assert.deepEqual(merged.games.map((game) => game.id), ['g_one'])
  assert.deepEqual(merged.games[0].players, [{ id: 'p_one', name: 'Local One' }])
  assert.deepEqual(merged.games[0].rounds, [{ id: 'r_one', entries: { p_one: { score: 1 } } }])
})

test('preserves player row versions and tombstones through cache persistence', () => {
  const storage = new MemoryStorage()
  const state = fromRemoteRows({
    people: [
      { id: 'p_live', name: 'Current Live', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.200Z' },
      { id: 'p_removed', name: 'Removed', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.300Z' },
      { id: 'p_standalone', name: 'Standalone', created_at: '1970-01-01T00:00:00.400Z', updated_at: '1970-01-01T00:00:00.450Z' },
    ],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.500Z', settings: {} }],
    gamePlayers: [
      { game_id: 'g_one', person_id: 'p_live', seat_order: 3, name_snapshot: 'Original Live', updated_at: '1970-01-01T00:00:00.250Z' },
      { game_id: 'g_one', person_id: 'p_removed', seat_order: 1, name_snapshot: 'Removed Snapshot', updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z' },
    ],
    rounds: [],
  })

  saveSyncStore({ cache: state, outbox: [], lastSyncAt: null, lastError: null, initialMigrationCompleted: false }, storage)
  const rows = toRemoteRows(loadSyncStore(storage).cache)
  assert.equal(rows.gamePlayers[0].updated_at, '1970-01-01T00:00:00.250Z')
  assert.equal(rows.gamePlayers[0].seat_order, 3)
  assert.equal(rows.gamePlayers[0].name_snapshot, 'Original Live')
  assert.equal(rows.gamePlayers[1].deleted_at, '1970-01-01T00:00:00.300Z')
  assert.equal(rows.gamePlayers[1].updated_at, '1970-01-01T00:00:00.300Z')
  assert.equal(rows.people.find((person) => person.id === 'p_standalone').created_at, '1970-01-01T00:00:00.400Z')
})
