import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compactCloudMetadata,
  conservativeSyncCursor,
  createInFlightSync,
  mergeSyncStore,
  registerSyncListeners,
} from '../src/lib/sync.js'
import { fromRemoteRows, hasCloudMetadata, mergeCloudCache } from '../src/lib/cloudState.js'

test('retains an outbox mutation enqueued while a deferred sync update is pending', async () => {
  let release
  const deferred = new Promise((resolve) => { release = resolve })
  const first = { cache: { games: [], roster: [], activeGameId: null }, outbox: [{ id: 'm_old' }] }
  const latest = mergeSyncStore(first, { ...first, outbox: [...first.outbox, { id: 'm_new' }] })
  const staleCompletion = deferred.then(() => ({ ...first, outbox: [] }))

  release()
  const completed = mergeSyncStore(latest, await staleCompletion, ['m_old'])

  assert.deepEqual(completed.outbox.map((mutation) => mutation.id), ['m_new'])
})

test('uses a conservative cursor for updates concurrent with deferred reads', async () => {
  let release
  const deferred = new Promise((resolve) => { release = resolve })
  const startedAt = '2026-01-03T12:00:00.000Z'
  const cursor = conservativeSyncCursor(null, startedAt)
  const read = deferred.then(() => ({ updated_at: '2026-01-03T12:00:00.500Z' }))

  release()
  const row = await read

  assert.ok(Date.parse(cursor) <= Date.parse(row.updated_at))
})

test('advances or holds the successful cursor without drifting backward', () => {
  const previous = '2026-01-03T12:00:00.000Z'
  const first = conservativeSyncCursor(previous, '2026-01-03T12:05:00.000Z')
  const second = conservativeSyncCursor(first, '2026-01-03T12:06:00.000Z')

  assert.ok(Date.parse(first) >= Date.parse(previous))
  assert.ok(Date.parse(second) >= Date.parse(first))
  assert.equal(
    conservativeSyncCursor('invalid', '2026-01-03T12:00:00.000Z'),
    '2026-01-03T11:59:00.000Z',
  )
})

test('preserves cloud metadata when an enqueue receives a spread-only nested state', () => {
  const metadataCache = fromRemoteRows({
    people: [{
      id: 'p_deleted',
      name: 'Deleted',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-01-02T00:00:00.000Z',
    }],
    games: [],
    game_players: [],
    rounds: [],
  })
  const spreadOnlyState = {
    ...metadataCache,
    games: [],
    roster: [{ id: 'p_new', name: 'New' }],
  }

  const updatedCache = mergeCloudCache(metadataCache, spreadOnlyState)

  assert.equal(hasCloudMetadata(spreadOnlyState), false)
  assert.equal(hasCloudMetadata(updatedCache), true)
  assert.equal(
    updatedCache[Symbol.for('gamescorer.cloudMetadata')].roster[0].deletedAt,
    '2026-01-02T00:00:00.000Z',
  )
})

test('compacts incremental metadata by entity key and keeps the newest version', () => {
  const compacted = compactCloudMetadata({
    roster: [],
    games: [],
    gamePlayers: [
      { gameId: 'g_one', id: 'p_one', updatedAt: 100, nameSnapshot: 'Old' },
      { gameId: 'g_one', id: 'p_one', updatedAt: 200, deletedAt: 200, nameSnapshot: 'Removed' },
      { gameId: 'g_one', id: 'p_two', updatedAt: 150, nameSnapshot: 'Two' },
    ],
    rounds: [
      { gameId: 'g_one', id: 'r_one', updatedAt: 100, roundIndex: 0 },
      { gameId: 'g_one', id: 'r_one', updatedAt: 300, roundIndex: 1 },
    ],
  })

  assert.deepEqual(compacted.gamePlayers, [
    { gameId: 'g_one', id: 'p_one', updatedAt: 200, deletedAt: 200, nameSnapshot: 'Removed' },
    { gameId: 'g_one', id: 'p_two', updatedAt: 150, nameSnapshot: 'Two' },
  ])
  assert.deepEqual(compacted.rounds, [{ gameId: 'g_one', id: 'r_one', updatedAt: 300, roundIndex: 1 }])
})

test('deduplicates sync requests and permits retry after a rejected request', async () => {
  let release
  let attempts = 0
  const deferred = new Promise((resolve) => { release = resolve })
  const run = createInFlightSync(async () => {
    attempts += 1
    if (attempts === 1) {
      await deferred
      throw new Error('temporary failure')
    }
    return 'synced'
  })

  const first = run()
  assert.equal(first, run())
  release()
  await assert.rejects(first, /temporary failure/)
  assert.equal(await run(), 'synced')
  assert.equal(attempts, 2)
})

test('removes online and visibility listeners during cleanup', () => {
  const listeners = new Map()
  const target = {
    addEventListener(name, listener) { listeners.set(`target:${name}`, listener) },
    removeEventListener(name, listener) { assert.equal(listeners.get(`target:${name}`), listener); listeners.delete(`target:${name}`) },
  }
  const document = {
    addEventListener(name, listener) { listeners.set(`document:${name}`, listener) },
    removeEventListener(name, listener) { assert.equal(listeners.get(`document:${name}`), listener); listeners.delete(`document:${name}`) },
  }
  let refreshes = 0
  const cleanup = registerSyncListeners({ target, document, onRefresh: () => { refreshes += 1 } })

  listeners.get('target:online')()
  listeners.get('document:visibilitychange')()
  cleanup()

  assert.equal(refreshes, 2)
  assert.equal(listeners.size, 0)
})
