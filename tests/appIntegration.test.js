import test from 'node:test'
import assert from 'node:assert/strict'
import { fromRemoteRows, toRemoteRows } from '../src/lib/cloudState.js'
import { loadSyncStore } from '../src/lib/sync.js'
import { loadReconciledState, saveState, saveStateToCloudCache, shouldOfferInitialMigration } from '../src/lib/storage.js'

class MemoryStorage {
  #values = new Map()

  getItem(key) { return this.#values.get(key) ?? null }
  setItem(key, value) { this.#values.set(key, String(value)) }
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

test('does not expose a cloud backup before the first successful sync', () => {
  const storage = new MemoryStorage()
  saveStateToCloudCache({ games: [{ id: 'g_local' }], roster: [] }, storage)
  assert.equal(loadReconciledState(storage), null)
})
