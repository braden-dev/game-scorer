import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudApi } from '../src/lib/cloudApi.js'

function fakeClient(rows = {}, errors = {}, rejections = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      const response = { data: rows[table] ?? [], error: errors[table] ?? null }
      const request = () => rejections[table]
        ? Promise.reject(rejections[table])
        : Promise.resolve(response)
      const query = {
        select(columns) {
          calls.push({ table, operation: 'select', columns })
          return query
        },
        gte(column, value) {
          calls.push({ table, operation: 'gte', column, value })
          return query
        },
        upsert(payload, options) {
          calls.push({ table, operation: 'upsert', payload, options })
          return request()
        },
        update(payload) {
          calls.push({ table, operation: 'update', payload })
          return query
        },
        eq(column, value) {
          calls.push({ table, operation: 'eq', column, value })
          return query
        },
        then(resolve, reject) {
          return request().then(resolve, reject)
        },
      }
      return query
    },
  }
  return client
}

test('fetchSnapshot returns all four tables, including tombstones', async () => {
  const rows = {
    people: [{ id: 'p_one', deleted_at: null }],
    games: [{ id: 'g_deleted', deleted_at: '2026-01-02T00:00:00Z' }],
    game_players: [{ game_id: 'g_deleted', person_id: 'p_one', deleted_at: '2026-01-02T00:00:00Z' }],
    rounds: [{ id: 'r_deleted', game_id: 'g_deleted', deleted_at: '2026-01-02T00:00:00Z' }],
  }
  const client = fakeClient(rows)

  const snapshot = await createCloudApi(client).fetchSnapshot()

  assert.deepEqual(snapshot, {
    people: rows.people,
    games: rows.games,
    gamePlayers: rows.game_players,
    rounds: rows.rounds,
  })
  assert.deepEqual(client.calls.filter((call) => call.operation === 'select').map((call) => call.table), [
    'people', 'games', 'game_players', 'rounds',
  ])
})

test('upsertRows writes rows in foreign-key order with conflict keys', async () => {
  const client = fakeClient()
  const rows = {
    people: [{ id: 'p_one', name: 'One', updated_at: '2026-01-01T00:00:00Z' }],
    games: [{ id: 'g_one', game_id: 'farkle', updated_at: '2026-01-01T00:00:00Z' }],
    gamePlayers: [{ game_id: 'g_one', person_id: 'p_one', seat_order: 0 }],
    rounds: [{ id: 'r_one', game_id: 'g_one', round_index: 0, entries: {} }],
  }

  await createCloudApi(client).upsertRows(rows)

  assert.deepEqual(client.calls.filter((call) => call.operation === 'upsert').map((call) => [
    call.table, call.options?.onConflict, call.payload,
  ]), [
    ['people', 'id', rows.people],
    ['games', 'id', rows.games],
    ['game_players', 'game_id,person_id', rows.gamePlayers],
    ['rounds', 'id', rows.rounds],
  ])
})

test('fetchRowsUpdatedSince filters every table without filtering tombstones', async () => {
  const client = fakeClient({
    people: [{ id: 'p_deleted', deleted_at: '2026-01-02T00:00:00Z' }],
    games: [],
    game_players: [],
    rounds: [],
  })
  const since = '2026-01-01T00:00:00.000Z'

  const result = await createCloudApi(client).fetchRowsUpdatedSince(since)

  assert.equal(result.people[0].deleted_at, '2026-01-02T00:00:00Z')
  assert.deepEqual(client.calls.filter((call) => call.operation === 'gte'), [
    { table: 'people', operation: 'gte', column: 'updated_at', value: since },
    { table: 'games', operation: 'gte', column: 'updated_at', value: since },
    { table: 'game_players', operation: 'gte', column: 'updated_at', value: since },
    { table: 'rounds', operation: 'gte', column: 'updated_at', value: since },
  ])
})

test('softDelete updates timestamps for a composite game player key', async () => {
  const client = fakeClient()
  const updatedAt = '2026-01-03T00:00:00.000Z'

  await createCloudApi(client).softDelete('gamePlayers', { gameId: 'g_one', personId: 'p_one' }, updatedAt)

  assert.deepEqual(client.calls.filter((call) => ['update', 'eq'].includes(call.operation)), [
    {
      table: 'game_players',
      operation: 'update',
      payload: { deleted_at: updatedAt, updated_at: updatedAt },
    },
    { table: 'game_players', operation: 'eq', column: 'game_id', value: 'g_one' },
    { table: 'game_players', operation: 'eq', column: 'person_id', value: 'p_one' },
  ])
})

test('Supabase errors name the table and provider message', async () => {
  const client = fakeClient({}, { rounds: { message: 'permission denied' } })

  await assert.rejects(
    createCloudApi(client).fetchSnapshot(),
    (error) => error instanceof Error
      && error.message.includes('rounds')
      && error.message.includes('permission denied'),
  )
})

test('Supabase write errors name the affected table', async () => {
  const upsertClient = fakeClient({}, { games: { message: 'upsert rejected' } })
  await assert.rejects(
    createCloudApi(upsertClient).upsertRows({ games: [{ id: 'g_one' }] }),
    /games.*upsert rejected/,
  )

  const deleteClient = fakeClient({}, { rounds: { message: 'update rejected' } })
  await assert.rejects(
    createCloudApi(deleteClient).softDelete('rounds', 'r_one', '2026-01-03T00:00:00.000Z'),
    /rounds.*update rejected/,
  )
})

test('rejected Supabase requests include table context', async () => {
  const client = fakeClient({}, {}, { rounds: new Error('network down') })

  await assert.rejects(
    createCloudApi(client).fetchSnapshot(),
    /rounds.*network down/,
  )
})
