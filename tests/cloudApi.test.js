import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudApi } from '../src/lib/cloudApi.js'

function fakeClient(rows = {}, errors = {}, rejections = {}, pages = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      let rangeStart = 0
      const response = () => ({
        data: pages[table]
          ? pages[table].find((page) => page.start === rangeStart)?.rows ?? []
          : rows[table] ?? [],
        error: errors[table] ?? null,
      })
      const request = () => rejections[table]
        ? Promise.reject(rejections[table])
        : Promise.resolve(response())
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
          rangeStart = from
          calls.push({ table, operation: 'range', from, to })
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
  const client = fakeClient({ game_players: [{ game_id: 'g_one', person_id: 'p_one' }] })
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

test('reads every table with stable ordering and page-boundary pagination', async () => {
  const pageSize = 1000
  const tables = ['people', 'games', 'game_players', 'rounds']
  const pages = Object.fromEntries(tables.map((table) => [table, [
    {
      start: 0,
      rows: Array.from({ length: pageSize }, (_, index) => ({
        id: `${table}-${index}`,
        game_id: `${table}-game`,
        person_id: `${table}-person-${index}`,
        updated_at: '2026-01-01T00:00:00.000Z',
      })),
    },
    {
      start: pageSize,
      rows: [{ id: `${table}-${pageSize}`, updated_at: '2026-01-02T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z' }],
    },
  ]]))
  const client = fakeClient({}, {}, {}, pages)
  const api = createCloudApi(client)

  const snapshot = await api.fetchSnapshot()
  const incremental = await api.fetchRowsUpdatedSince('2026-01-01T00:00:00.000Z')

  for (const key of ['people', 'games', 'gamePlayers', 'rounds']) {
    assert.equal(snapshot[key].length, pageSize + 1)
    assert.equal(incremental[key].length, pageSize + 1)
  }
  assert.equal(snapshot.games.at(-1).deleted_at, '2026-01-02T00:00:00.000Z')

  const reads = client.calls.filter((call) => call.operation === 'select')
  assert.equal(reads.length, 16)
  assert.deepEqual(
    client.calls.filter((call) => call.operation === 'order').slice(0, 4),
    [
      { table: 'people', operation: 'order', column: 'id', options: { ascending: true } },
      { table: 'games', operation: 'order', column: 'id', options: { ascending: true } },
      { table: 'game_players', operation: 'order', column: 'game_id', options: { ascending: true } },
      { table: 'game_players', operation: 'order', column: 'person_id', options: { ascending: true } },
    ],
  )
  assert.equal(client.calls.filter((call) => call.operation === 'range' && call.from === pageSize).length, 8)
  assert.equal(client.calls.filter((call) => call.operation === 'gte').length, 8)
})

test('softDelete updates timestamps for a composite game player key', async () => {
  const client = fakeClient({ game_players: [{ game_id: 'g_one', person_id: 'p_one' }] })
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
  assert.deepEqual(client.calls.filter((call) => call.operation === 'select'), [
    { table: 'game_players', operation: 'select', columns: 'game_id,person_id' },
  ])
})

test('softDelete rejects when no row matched the requested key', async () => {
  const client = fakeClient()

  await assert.rejects(
    createCloudApi(client).softDelete('rounds', 'missing', '2026-01-03T00:00:00.000Z'),
    /rounds.*no rows matched/,
  )
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
