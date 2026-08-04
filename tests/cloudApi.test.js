import test from 'node:test'
import assert from 'node:assert/strict'
import { createCloudApi } from '../src/lib/cloudApi.js'
import { stampMigrationRows, toRemoteRows } from '../src/lib/cloudState.js'

function fakeClient(rows = {}, errors = {}, rejections = {}, pages = {}) {
  const calls = []
  const client = {
    calls,
    from(table) {
      let rangeStart = 0
      let writeData
      const response = () => ({
        data: writeData ?? (pages[table]
          ? pages[table].find((page) => page.start === rangeStart)?.rows ?? []
          : rows[table] ?? []),
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
        limit(count) {
          calls.push({ table, operation: 'limit', count })
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
        insert(payload) {
          calls.push({ table, operation: 'insert', payload })
          writeData = payload
          return query
        },
        update(payload) {
          calls.push({ table, operation: 'update', payload })
          return query
        },
        eq(column, value) {
          calls.push({ table, operation: 'eq', column, value })
          return query
        },
        gt(column, value) {
          calls.push({ table, operation: 'gt', column, value })
          return query
        },
        or(value) {
          calls.push({ table, operation: 'or', value })
          return query
        },
        is(column, value) {
          calls.push({ table, operation: 'is', column, value })
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

function mutableClient(initialRows = {}, hooks = {}) {
  const tables = Object.fromEntries(Object.entries(initialRows).map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]))
  const calls = []
  const readCounts = {}
  const timestampColumns = new Set(['created_at', 'updated_at', 'deleted_at', 'finished_at'])
  const normalizeInsertedRow = (table, row) => {
    const inserted = { ...row }
    for (const [column, value] of Object.entries(hooks.serverDefaults?.[table] ?? {})) {
      if (!(column in inserted)) inserted[column] = value
    }
    if (!hooks.normalizeTimestamps) return inserted
    return Object.fromEntries(Object.entries(inserted).map(([column, value]) => {
      if (!timestampColumns.has(column) || value === null || value === undefined) return [column, value]
      const milliseconds = Date.parse(String(value))
      if (!Number.isFinite(milliseconds)) return [column, value]
      const iso = new Date(milliseconds).toISOString()
      return [column, iso.replace(/\.(\d{3})Z$/, '.$1000+00:00')]
    }))
  }
  const keyFor = (table, row) => table === 'game_players'
    ? `${row.game_id}\u0000${row.person_id}`
    : row.id
  const client = {
    calls,
    rows(table) { return tables[table] ?? [] },
    from(table) {
      let action = 'select'
      let payload = null
      const filters = []
      const orders = []
      let rangeStart = 0
      let rangeEnd = Number.POSITIVE_INFINITY
      let limitCount = Number.POSITIVE_INFINITY
      let orFilter = null
      const splitFilter = (value) => {
        const parts = []
        let start = 0
        let depth = 0
        let quoted = false
        let escaped = false
        for (let index = 0; index < value.length; index += 1) {
          const character = value[index]
          if (quoted) {
            if (escaped) escaped = false
            else if (character === '\\') escaped = true
            else if (character === '"') quoted = false
          } else if (character === '"') {
            quoted = true
          } else if (character === '(') {
            depth += 1
          } else if (character === ')') {
            depth -= 1
          } else if (character === ',' && depth === 0) {
            parts.push(value.slice(start, index))
            start = index + 1
          }
        }
        parts.push(value.slice(start))
        return parts
      }
      const parseFilter = (expression) => {
        if (expression.startsWith('and(') && expression.endsWith(')')) {
          const predicates = splitFilter(expression.slice(4, -1)).map(parseFilter)
          return (row) => predicates.every((predicate) => predicate(row))
        }
        const firstDot = expression.indexOf('.')
        const secondDot = expression.indexOf('.', firstDot + 1)
        const column = expression.slice(0, firstDot)
        const operator = expression.slice(firstDot + 1, secondDot)
        let value = expression.slice(secondDot + 1)
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.slice(1, -1).replace(/\\(["\\])/g, '$1')
        }
        if (operator === 'eq') return (row) => row[column] === value
        if (operator === 'gt') return (row) => row[column] > value
        throw new Error(`Unsupported fake filter: ${expression}`)
      }
      const query = {
        select(columns) {
          calls.push({ table, operation: 'select', columns })
          return query
        },
        order(column, options) {
          calls.push({ table, operation: 'order', column, options })
          orders.push({ column, ascending: options?.ascending !== false })
          return query
        },
        range(from, to) {
          calls.push({ table, operation: 'range', from, to })
          rangeStart = from
          rangeEnd = to
          return query
        },
        limit(count) {
          calls.push({ table, operation: 'limit', count })
          limitCount = count
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
        gt(column, value) {
          calls.push({ table, operation: 'gt', column, value })
          filters.push((row) => row[column] > value)
          return query
        },
        or(value) {
          calls.push({ table, operation: 'or', value })
          orFilter = value
          return query
        },
        is(column, value) {
          calls.push({ table, operation: 'is', column, value })
          filters.push((row) => (row[column] ?? null) === value)
          return query
        },
        upsert(rows, options) {
          action = 'upsert'
          payload = rows
          query.upsertOptions = options
          calls.push({ table, operation: 'upsert', payload: rows, options })
          return query
        },
        insert(rows) {
          action = 'insert'
          payload = rows
          calls.push({ table, operation: 'insert', payload: rows })
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
            if (action === 'select') {
              const readNumber = readCounts[table] ?? 0
              hooks.beforeRead?.(table, readNumber, tableRows)
              readCounts[table] = readNumber + 1
            }
            const matches = tableRows
              .filter((row) => filters.every((matchesFilter) => matchesFilter(row)))
              .filter((row) => !orFilter || splitFilter(orFilter).some((expression) => parseFilter(expression)(row)))
              .sort((left, right) => {
                for (const { column, ascending } of orders) {
                  if (left[column] === right[column]) continue
                  const result = left[column] > right[column] ? 1 : -1
                  return ascending ? result : -result
                }
                return 0
            })
            const page = matches.slice(rangeStart, Math.min(rangeEnd + 1, rangeStart + limitCount))
            let data = action === 'select' ? page : matches
            if (action === 'update') {
              for (const row of matches) Object.assign(row, payload)
            } else if (action === 'insert') {
              tableRows.push(...payload.map((row) => normalizeInsertedRow(table, row)))
              data = payload
            } else if (action === 'upsert') {
              hooks.beforeUpsert?.(table, payload, tableRows)
              data = payload.flatMap((nextRow) => {
                const existing = tableRows.find((row) => keyFor(table, row) === keyFor(table, nextRow))
                if (existing) {
                  if (!query.upsertOptions?.ignoreDuplicates) Object.assign(existing, nextRow)
                  return query.upsertOptions?.ignoreDuplicates ? [] : [nextRow]
                }
                tableRows.push(normalizeInsertedRow(table, nextRow))
                return [nextRow]
              })
            }
            return Promise.resolve({ data, error: null }).then(resolve, reject)
          } catch (error) {
            return Promise.reject(error).then(resolve, reject)
          }
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

test('upsertRows supplies conflict keys while retaining version-aware updates', async () => {
  const client = mutableClient({ game_players: [{ game_id: 'g_one', person_id: 'p_one' }] })
  const rows = {
    people: [{ id: 'p_one', name: 'One', updated_at: '2026-01-01T00:00:00Z' }],
    games: [{ id: 'g_one', game_id: 'farkle', updated_at: '2026-01-01T00:00:00Z' }],
    gamePlayers: [{ game_id: 'g_one', person_id: 'p_one', seat_order: 0 }],
    rounds: [{ id: 'r_one', game_id: 'g_one', round_index: 0, entries: {} }],
  }

  await createCloudApi(client).upsertRows(rows)

  assert.deepEqual(client.calls.filter((call) => call.operation === 'upsert').map((call) => [
    call.table, call.options?.onConflict, call.options?.ignoreDuplicates,
  ]), [
    ['people', 'id', true],
    ['games', 'id', true],
    ['game_players', 'game_id,person_id', true],
    ['rounds', 'id', true],
  ])
  assert.deepEqual(client.calls.filter((call) => call.operation === 'eq' && call.table === 'game_players').map((call) => [call.column, call.value]), [
    ['game_id', 'g_one'], ['person_id', 'p_one'],
    ['game_id', 'g_one'], ['person_id', 'p_one'],
    ['game_id', 'g_one'], ['person_id', 'p_one'],
  ])
})

test('accepts a newly inserted row after PostgreSQL normalizes timestamp formatting', async () => {
  const client = mutableClient({}, { normalizeTimestamps: true })

  const result = await createCloudApi(client).upsertRows({ games: [{
    id: 'g_timestamp_round_trip',
    game_id: 'dutch-blitz',
    created_at: '2026-08-04T18:26:03.103Z',
    updated_at: '2026-08-04T18:26:03.103Z',
    finished_at: null,
    settings: { target: 75, blitzPenalty: 2 },
    deleted_at: null,
  }] })

  assert.equal(result.games[0].id, 'g_timestamp_round_trip')
  assert.equal(client.rows('games')[0].created_at, '2026-08-04T18:26:03.103000+00:00')
})

test('accepts an equivalent inserted row when PostgreSQL adds server defaults', async () => {
  const client = mutableClient({}, {
    normalizeTimestamps: true,
    serverDefaults: {
      games: {
        created_at: '2026-08-04T18:26:03.103Z',
        updated_at: '2026-08-04T18:26:03.103Z',
        settings: {},
        finished_at: null,
        deleted_at: null,
      },
    },
  })

  const result = await createCloudApi(client).upsertRows({ games: [{
    id: 'g_server_default',
    game_id: 'dutch-blitz',
  }] })

  assert.equal(result.games[0].created_at, '2026-08-04T18:26:03.103000+00:00')
  assert.equal(result.games[0].updated_at, '2026-08-04T18:26:03.103000+00:00')
  assert.deepEqual(result.games[0].settings, {})
  assert.equal(result.games[0].finished_at, null)
  assert.equal(result.games[0].deleted_at, null)
})

test('compares non-UTC timestamps at application millisecond precision', async () => {
  const client = mutableClient({}, { normalizeTimestamps: true })

  await createCloudApi(client).upsertRows({ games: [{
    id: 'g_timestamp_offset',
    game_id: 'dutch-blitz',
    created_at: '2026-08-04T13:26:03.103-05:00',
    updated_at: '2026-08-04T13:26:03.103-05:00',
    finished_at: '2026-08-04T13:27:03.103-05:00',
    settings: { target: 75, blitzPenalty: 2 },
    deleted_at: null,
  }] })

  assert.equal(client.rows('games')[0].created_at, '2026-08-04T18:26:03.103000+00:00')
  assert.equal(client.rows('games')[0].finished_at, '2026-08-04T18:27:03.103000+00:00')
})

test('does not treat a malformed timestamp as null during equal-version comparison', async () => {
  const updatedAt = '2026-08-04T18:26:03.103Z'
  const client = mutableClient({ games: [{
    id: 'g_invalid_finished_at', game_id: 'dutch-blitz',
    created_at: '2026-08-04T18:26:02.103Z', updated_at: updatedAt,
    finished_at: null, settings: {}, deleted_at: null,
  }] })

  await assert.rejects(
    createCloudApi(client).upsertRows({ games: [{
      id: 'g_invalid_finished_at', game_id: 'dutch-blitz',
      created_at: '2026-08-04T18:26:02.103Z', updated_at: updatedAt,
      finished_at: 'not-a-timestamp', settings: {}, deleted_at: null,
    }] }),
    /games.*conflicting equal-version row/,
  )
  assert.equal(client.rows('games')[0].finished_at, null)
})

test('rejects an invalid updated_at instead of treating it as a missing version', async () => {
  const updatedAt = '2026-08-04T18:26:03.103Z'
  const client = mutableClient({ games: [{
    id: 'g_invalid_updated_at', game_id: 'dutch-blitz',
    created_at: '2026-08-04T18:26:02.103Z', updated_at: updatedAt,
    finished_at: null, settings: {}, deleted_at: null,
  }] })

  await assert.rejects(
    createCloudApi(client).upsertRows({ games: [{
      id: 'g_invalid_updated_at', game_id: 'dutch-blitz',
      created_at: '2026-08-04T18:26:02.103Z', updated_at: 'not-a-timestamp',
      finished_at: null, settings: {}, deleted_at: null,
    }] }),
    /games.*invalid timestamp/,
  )
  assert.equal(client.rows('games')[0].updated_at, updatedAt)
})

test('rejects an invalid deleted_at instead of treating it as a missing version', async () => {
  const updatedAt = '2026-08-04T18:26:03.103Z'
  const client = mutableClient({ games: [{
    id: 'g_invalid_deleted_at', game_id: 'dutch-blitz',
    created_at: '2026-08-04T18:26:02.103Z', updated_at: updatedAt,
    finished_at: null, settings: {}, deleted_at: null,
  }] })

  await assert.rejects(
    createCloudApi(client).upsertRows({ games: [{
      id: 'g_invalid_deleted_at', game_id: 'dutch-blitz',
      created_at: '2026-08-04T18:26:02.103Z', updated_at: updatedAt,
      finished_at: null, settings: {}, deleted_at: 'not-a-timestamp',
    }] }),
    /games.*invalid timestamp/,
  )
  assert.equal(client.rows('games')[0].deleted_at, null)
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

test('migration rows use a fresh consistent version visible to a stale incremental peer', async () => {
  const localRows = toRemoteRows({
    roster: [{ id: 'p_migration', name: 'Migration Player', createdAt: 100 }],
    games: [{
      id: 'g_migration', gameId: 'farkle', createdAt: 100, updatedAt: 200,
      players: [{ id: 'p_migration', name: 'Migration Player' }], settings: {},
      rounds: [{ id: 'r_migration', entries: { p_migration: { score: 42 } }, updatedAt: 300 }],
      finishedAt: null,
    }],
  })
  localRows.people.push({
    id: 'p_deleted', name: 'Deleted', normalized_name: 'deleted',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:10.000Z', deleted_at: '2026-01-01T00:00:10.000Z',
  })
  const migrationVersion = '2026-08-05T00:00:01.000Z'
  const stampedRows = stampMigrationRows(localRows, migrationVersion)
  const client = mutableClient({})
  const api = createCloudApi(client)

  await api.upsertRows(stampedRows)
  const stalePeerRows = await api.fetchRowsUpdatedSince('2026-08-04T23:59:59.000Z')

  assert.equal(stampedRows.games[0].updated_at, migrationVersion)
  assert.equal(stampedRows.rounds[0].updated_at, migrationVersion)
  assert.equal(stampedRows.games[0].created_at, localRows.games[0].created_at)
  assert.equal(stampedRows.people.find(({ id }) => id === 'p_deleted').deleted_at, '2026-01-01T00:00:10.000Z')
  assert.deepEqual(stalePeerRows.games.map(({ id }) => id), ['g_migration'])
  assert.deepEqual(stalePeerRows.rounds.map(({ id }) => id), ['r_migration'])
})

test('restore is idempotent when an offline delete never reached the live remote row', async () => {
  const liveRow = {
    id: 'r_offline_undo', game_id: 'g_offline_undo', round_index: 0,
    entries: { p_one: { score: 42 } },
    updated_at: '2026-08-04T00:00:00.000Z', deleted_at: null,
  }
  const client = mutableClient({ rounds: [liveRow] })
  const result = await createCloudApi(client).restoreRows(
    { rounds: [{ ...liveRow, updated_at: '2026-08-03T00:00:20.000Z' }] },
    { rounds: [{ id: liveRow.id, game_id: liveRow.game_id, updated_at: '2026-08-04T00:00:10.000Z', deleted_at: '2026-08-04T00:00:10.000Z' }] },
  )

  assert.deepEqual(result.rounds, [liveRow])
  assert.deepEqual(client.rows('rounds'), [liveRow])
  assert.equal(client.calls.some((call) => call.operation === 'update'), false)
})

test('rejects a restore row with an invalid version before writing it', async () => {
  const deletedAt = '2026-08-04T00:00:10.000Z'
  const serverAt = '2026-08-04T00:00:10.000Z'
  const existing = {
    id: 'r_invalid_restore', game_id: 'g_invalid_restore', round_index: 0,
    entries: { p_one: { score: 42 } }, updated_at: serverAt, deleted_at: deletedAt,
  }
  const client = mutableClient({ rounds: [existing] })

  await assert.rejects(
    createCloudApi(client).restoreRows({ rounds: [{
      ...existing, updated_at: 'not-a-timestamp', deleted_at: null,
    }] }, { rounds: [{
      id: existing.id, game_id: existing.game_id, updated_at: serverAt, deleted_at: deletedAt,
    }] }),
    /rounds.*invalid timestamp/,
  )
  assert.deepEqual(client.rows('rounds'), [existing])
  assert.equal(client.calls.some((call) => call.operation === 'update'), false)
})

test('rejects a restore when the existing tombstone has an invalid version', async () => {
  const serverAt = '2026-08-04T00:00:10.000Z'
  const existing = {
    id: 'r_invalid_tombstone', game_id: 'g_invalid_tombstone', round_index: 0,
    entries: { p_one: { score: 42 } }, updated_at: serverAt, deleted_at: 'not-a-timestamp',
  }
  const client = mutableClient({ rounds: [existing] })

  await assert.rejects(
    createCloudApi(client).restoreRows({ rounds: [{
      ...existing, updated_at: '2026-08-04T00:00:20.000Z', deleted_at: null,
    }] }, { rounds: [{
      id: existing.id, game_id: existing.game_id, updated_at: serverAt,
      deleted_at: '2026-08-04T00:00:10.000Z',
    }] }),
    /rounds.*invalid timestamp/,
  )
  assert.deepEqual(client.rows('rounds'), [existing])
  assert.equal(client.calls.some((call) => call.operation === 'update'), false)
})

test('reads every table with stable ordering, since filtering, and keyset page sizes', async () => {
  const pageSize = 1000
  const rowFor = (table, index) => table === 'game_players'
    ? {
      game_id: index < pageSize ? 'g_one' : 'g_two',
      person_id: `p_${String(index % pageSize).padStart(4, '0')}`,
      updated_at: index < pageSize ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
    }
    : {
      id: `${table}-${String(index).padStart(4, '0')}`,
      updated_at: index < pageSize ? '2026-01-01T00:00:00.000Z' : '2026-01-02T00:00:00.000Z',
      ...(table === 'games' ? { deleted_at: index === pageSize ? '2026-01-02T00:00:00.000Z' : null } : {}),
    }
  const tables = ['people', 'games', 'game_players', 'rounds']
  const rows = Object.fromEntries(tables.map((table) => [
    table,
    Array.from({ length: pageSize + 1 }, (_, index) => rowFor(table, index)),
  ]))
  const client = mutableClient(rows)
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
  assert.equal(client.calls.filter((call) => call.operation === 'range').length, 0)
  assert.equal(client.calls.filter((call) => call.operation === 'limit' && call.count === pageSize).length, 16)
  assert.equal(client.calls.filter((call) => call.operation === 'gte').length, 8)
})

test('does not skip rows when a mutable table changes before the next keyset page', async () => {
  const people = Array.from({ length: 1001 }, (_, index) => ({
    id: `p_${String(index).padStart(4, '0')}`,
    updated_at: '2026-01-01T00:00:00.000Z',
  }))
  const client = mutableClient({ people }, {
    beforeRead(table, readNumber, tableRows) {
      if (table !== 'people' || readNumber !== 1) return
      tableRows.splice(tableRows.findIndex(({ id }) => id === 'p_0000'), 1)
      tableRows.push({ id: 'p_1001', updated_at: '2026-01-01T00:00:00.000Z' })
    },
  })

  const snapshot = await createCloudApi(client).fetchSnapshot()
  const ids = snapshot.people.map(({ id }) => id)

  assert.equal(ids.length, 1002)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.includes('p_1000'))
  assert.ok(ids.includes('p_1001'))
  assert.equal(client.calls.filter((call) => call.operation === 'range').length, 0)
  assert.deepEqual(client.calls.filter((call) => call.operation === 'gt'), [
    { table: 'people', operation: 'gt', column: 'id', value: 'p_0999' },
  ])
})

test('uses escaped lexicographic filters for composite game player keys', async () => {
  const gamePlayers = [
    ...Array.from({ length: 999 }, (_, index) => ({
      game_id: 'g1',
      person_id: `p${String(index).padStart(4, '0')}`,
      updated_at: '2026-01-01T00:00:00.000Z',
    })),
    { game_id: 'g1', person_id: 'p0999,(x)', updated_at: '2026-01-01T00:00:00.000Z' },
    { game_id: 'g2', person_id: 'p0000', updated_at: '2026-01-01T00:00:00.000Z' },
  ]
  const client = mutableClient({ game_players: gamePlayers }, {
    beforeRead(table, readNumber, tableRows) {
      if (table !== 'game_players' || readNumber !== 1) return
      tableRows.splice(tableRows.findIndex(({ game_id, person_id }) => game_id === 'g1' && person_id === 'p0000'), 1)
      tableRows.push({ game_id: 'g2', person_id: 'p0001', updated_at: '2026-01-01T00:00:00.000Z' })
    },
  })

  const snapshot = await createCloudApi(client).fetchSnapshot()
  const keys = snapshot.gamePlayers.map(({ game_id, person_id }) => `${game_id}:${person_id}`)

  assert.equal(keys.length, 1002)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.includes('g2:p0000'))
  assert.ok(keys.includes('g2:p0001'))
  assert.deepEqual(client.calls.filter((call) => call.operation === 'or'), [{
    table: 'game_players',
    operation: 'or',
    value: 'game_id.gt.g1,and(game_id.eq.g1,person_id.gt."p0999,(x)")',
  }])
})

test('softDelete updates timestamps for a composite game player key', async () => {
  const client = mutableClient({ game_players: [{
    game_id: 'g_one', person_id: 'p_one', seat_order: 2, name_snapshot: 'Original',
    updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null,
  }] })
  const updatedAt = '2026-01-03T00:00:00.000Z'

  const result = await createCloudApi(client).softDelete('gamePlayers', { gameId: 'g_one', personId: 'p_one' }, updatedAt)

  assert.deepEqual(result, {
    game_id: 'g_one', person_id: 'p_one', seat_order: 2, name_snapshot: 'Original',
    updated_at: updatedAt, deleted_at: updatedAt,
  })
  assert.deepEqual(client.rows('game_players'), [result])
  assert.deepEqual(client.calls.filter((call) => call.operation === 'update'), [{
    table: 'game_players',
    operation: 'update',
    payload: { deleted_at: updatedAt, updated_at: updatedAt },
  }])
  assert.deepEqual(client.calls.filter((call) => call.operation === 'eq').map((call) => [call.column, call.value]), [
    ['game_id', 'g_one'], ['person_id', 'p_one'],
    ['game_id', 'g_one'], ['person_id', 'p_one'],
    ['updated_at', '2026-01-02T00:00:00.000Z'],
  ])
  assert.deepEqual(client.calls.filter((call) => call.operation === 'select'), [
    { table: 'game_players', operation: 'select', columns: '*' },
    { table: 'game_players', operation: 'select', columns: '*' },
  ])
})

test('softDelete returns complete round tombstone metadata', async () => {
  const row = {
    id: 'r_one', game_id: 'g_one', round_index: 3, entries: { p_one: { score: 7 } },
    updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null,
  }
  const client = mutableClient({ rounds: [row] })
  const result = await createCloudApi(client).softDelete('rounds', 'r_one', '2026-01-03T00:00:00.000Z')

  assert.deepEqual(result, {
    ...row,
    updated_at: '2026-01-03T00:00:00.000Z',
    deleted_at: '2026-01-03T00:00:00.000Z',
  })
  assert.deepEqual(client.rows('rounds'), [result])
  assert.deepEqual(client.calls.filter((call) => call.operation === 'select'), [
    { table: 'rounds', operation: 'select', columns: '*' },
    { table: 'rounds', operation: 'select', columns: '*' },
  ])
})

test('softDelete rejects when no row matched the requested key', async () => {
  const client = fakeClient()

  await assert.rejects(
    createCloudApi(client).softDelete('rounds', 'missing', '2026-01-03T00:00:00.000Z'),
    /rounds.*no rows matched/,
  )
})

test('rejects softDelete when the existing server version is invalid', async () => {
  const existing = {
    id: 'r_invalid_server_version', game_id: 'g_invalid_server_version', round_index: 0,
    entries: { p_one: { score: 42 } }, updated_at: 'not-a-timestamp', deleted_at: null,
  }
  const client = mutableClient({ rounds: [existing] })

  await assert.rejects(
    createCloudApi(client).softDelete('rounds', existing.id, '2026-08-04T00:00:20.000Z'),
    /rounds.*invalid timestamp/,
  )
  assert.deepEqual(client.rows('rounds'), [existing])
  assert.equal(client.calls.some((call) => call.operation === 'update'), false)
})

test('rejects a stale upsert without overwriting a newer remote row', async () => {
  const client = mutableClient({ people: [{ id: 'p_one', name: 'Remote', updated_at: '2026-01-02T00:00:00.000Z' }] })

  await assert.rejects(
    createCloudApi(client).upsertRows({ people: [{ id: 'p_one', name: 'Stale local', updated_at: '2026-01-01T00:00:00.000Z' }] }),
    /people.*newer remote row/,
  )
  assert.equal(client.rows('people')[0].name, 'Remote')
})

test('rejects an equal-version conflicting upsert but accepts an identical retry', async () => {
  const updatedAt = '2026-01-02T00:00:00.000Z'
  const client = mutableClient({ people: [{
    id: 'p_equal', name: 'Remote', updated_at: updatedAt, deleted_at: null,
  }] })
  const api = createCloudApi(client)

  await assert.rejects(
    api.upsertRows({ people: [{
      id: 'p_equal', name: 'Local', updated_at: updatedAt, deleted_at: null,
    }] }),
    /people.*conflicting equal-version row/,
  )
  assert.equal(client.rows('people')[0].name, 'Remote')

  await api.upsertRows({ people: [{
    id: 'p_equal', name: 'Remote', updated_at: updatedAt, deleted_at: null,
  }] })
  assert.equal(client.rows('people')[0].name, 'Remote')
})

test('accepts a scalar upsert retry when the server only advanced updated_at', async () => {
  const attemptedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const canonical = { id: 'p_retry', name: 'Same payload', updated_at: serverAt, deleted_at: null }
  const client = mutableClient({ people: [canonical] })

  const result = await createCloudApi(client).upsertRows({ people: [{
    id: 'p_retry', name: 'Same payload', updated_at: attemptedAt, deleted_at: null,
  }] })

  assert.deepEqual(result.people, [canonical])
  assert.deepEqual(client.rows('people'), [canonical])
})

test('accepts a composite upsert retry when the server only advanced updated_at', async () => {
  const attemptedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const canonical = {
    game_id: 'g_retry', person_id: 'p_retry', seat_order: 1, name_snapshot: 'Same payload',
    updated_at: serverAt, deleted_at: null,
  }
  const client = mutableClient({ game_players: [canonical] })

  const result = await createCloudApi(client).upsertRows({ gamePlayers: [{
    game_id: 'g_retry', person_id: 'p_retry', seat_order: 1, name_snapshot: 'Same payload',
    updated_at: attemptedAt, deleted_at: null,
  }] })

  assert.deepEqual(result.gamePlayers, [canonical])
  assert.deepEqual(client.rows('game_players'), [canonical])
})

test('rejects stale composite game-player upserts', async () => {
  const client = mutableClient({
    game_players: [{ game_id: 'g_one', person_id: 'p_one', name_snapshot: 'Remote', updated_at: '2026-01-02T00:00:00.000Z' }],
  })

  await assert.rejects(
    createCloudApi(client).upsertRows({
      gamePlayers: [{ game_id: 'g_one', person_id: 'p_one', name_snapshot: 'Stale local', updated_at: '2026-01-01T00:00:00.000Z' }],
    }),
    /game_players.*newer remote row/,
  )
  assert.equal(client.rows('game_players')[0].name_snapshot, 'Remote')
})

test('rejects a stale soft delete without overwriting a newer remote row', async () => {
  const client = mutableClient({
    rounds: [{ id: 'r_one', game_id: 'g_one', updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null }],
  })

  await assert.rejects(
    createCloudApi(client).softDelete('rounds', 'r_one', '2026-01-01T00:00:00.000Z'),
    /rounds.*newer remote row/,
  )
  assert.equal(client.rows('rounds')[0].deleted_at, null)
})

test('rejects an equal-version conflicting soft delete but accepts an idempotent retry', async () => {
  const updatedAt = '2026-01-02T00:00:00.000Z'
  const liveClient = mutableClient({
    rounds: [{ id: 'r_equal', game_id: 'g_one', updated_at: updatedAt, deleted_at: null }],
  })

  await assert.rejects(
    createCloudApi(liveClient).softDelete('rounds', 'r_equal', updatedAt),
    /rounds.*conflicting equal-version row/,
  )
  assert.equal(liveClient.rows('rounds')[0].deleted_at, null)

  const deletedClient = mutableClient({
    rounds: [{ id: 'r_equal', game_id: 'g_one', updated_at: updatedAt, deleted_at: updatedAt }],
  })
  await createCloudApi(deletedClient).softDelete('rounds', 'r_equal', updatedAt)
  assert.equal(deletedClient.rows('rounds')[0].deleted_at, updatedAt)
})

test('accepts a scalar delete retry when the desired tombstone has a newer server updated_at', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const canonical = { id: 'r_retry', game_id: 'g_retry', updated_at: serverAt, deleted_at: deletedAt }
  const client = mutableClient({ rounds: [canonical] })

  const result = await createCloudApi(client).softDelete('rounds', 'r_retry', deletedAt)

  assert.deepEqual(result, canonical)
  assert.deepEqual(client.rows('rounds'), [canonical])
})

test('accepts a scalar delete retry when deleted_at matches despite server clock skew', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const canonical = { id: 'r_skewed', game_id: 'g_skewed', updated_at: '2026-01-01T23:59:00.000Z', deleted_at: deletedAt }
  const client = mutableClient({ rounds: [canonical] })

  const result = await createCloudApi(client).softDelete('rounds', 'r_skewed', deletedAt)

  assert.deepEqual(result, canonical)
  assert.deepEqual(client.rows('rounds'), [canonical])
})

test('accepts a composite delete retry when the desired tombstone has a newer server updated_at', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const canonical = {
    game_id: 'g_retry', person_id: 'p_retry', updated_at: serverAt, deleted_at: deletedAt,
  }
  const client = mutableClient({ game_players: [canonical] })

  const result = await createCloudApi(client).softDelete(
    'gamePlayers', { gameId: 'g_retry', personId: 'p_retry' }, deletedAt,
  )

  assert.deepEqual(result, canonical)
  assert.deepEqual(client.rows('game_players'), [canonical])
})

test('restores a matching tombstone with its server version despite a newer trigger timestamp', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const restoreAt = '2026-01-02T00:00:02.000Z'
  const client = mutableClient({
    rounds: [{
      id: 'r_restore', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
      updated_at: serverAt, deleted_at: deletedAt,
    }],
  })
  const result = await createCloudApi(client).restoreRows({
    rounds: [{
      id: 'r_restore', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
      updated_at: restoreAt, deleted_at: null,
    }],
  }, {
    rounds: [{ id: 'r_restore', game_id: 'g_restore', updated_at: serverAt, deleted_at: deletedAt }],
  })

  assert.deepEqual(result.rounds, [{
    id: 'r_restore', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
    updated_at: restoreAt, deleted_at: null,
  }])
  assert.deepEqual(client.rows('rounds'), result.rounds)
  assert.deepEqual(client.calls.filter((call) => call.table === 'rounds' && call.operation === 'eq').slice(-3), [
    { table: 'rounds', operation: 'eq', column: 'id', value: 'r_restore' },
    { table: 'rounds', operation: 'eq', column: 'deleted_at', value: deletedAt },
    { table: 'rounds', operation: 'eq', column: 'updated_at', value: serverAt },
  ])
})

test('rejects restore rows that do not advance the canonical tombstone version', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const baseRow = {
    id: 'r_restore_version', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
    updated_at: serverAt, deleted_at: null,
  }
  const expected = { rounds: [{ id: 'r_restore_version', updated_at: serverAt, deleted_at: deletedAt }] }

  for (const updatedAt of [serverAt, '2026-01-02T00:00:00.999Z']) {
    const client = mutableClient({ rounds: [{
      ...baseRow, updated_at: serverAt, deleted_at: deletedAt,
    }] })
    await assert.rejects(
      createCloudApi(client).restoreRows({ rounds: [{ ...baseRow, updated_at: updatedAt }] }, expected),
      /rounds.*newer remote row/,
    )
  }

  const nonFiniteClient = mutableClient({ rounds: [{
    ...baseRow, updated_at: serverAt, deleted_at: deletedAt,
  }] })
  await assert.rejects(
    createCloudApi(nonFiniteClient).restoreRows({ rounds: [{
      ...baseRow, updated_at: null, deleted_at: null,
    }] }, expected),
    /rounds.*newer remote row/,
  )
})

test('compares restore tombstone timestamps semantically while retaining conflicts for different values', async () => {
  const deletedAt = '2026-01-02T00:00:00.123Z'
  const serverAt = '2026-01-02T00:00:01.123Z'
  const restoreAt = '2026-01-02T00:00:02.000Z'
  const client = mutableClient({
    rounds: [{
      id: 'r_restore_format', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
      updated_at: serverAt, deleted_at: deletedAt,
    }],
  })
  const formattedTombstone = {
    id: 'r_restore_format',
    game_id: 'g_restore',
    updated_at: '2026-01-02 00:00:01.123456+00:00',
    deleted_at: '2026-01-02 00:00:00.123456+00:00',
  }

  const result = await createCloudApi(client).restoreRows({
    rounds: [{
      id: 'r_restore_format', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
      updated_at: restoreAt, deleted_at: null,
    }],
  }, { rounds: [formattedTombstone] })

  assert.equal(result.rounds[0].deleted_at, null)

  const changedTimestampClient = mutableClient({
    rounds: [{
      id: 'r_restore_format_conflict', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
      updated_at: serverAt, deleted_at: deletedAt,
    }],
  })
  await assert.rejects(
    createCloudApi(changedTimestampClient).restoreRows({
      rounds: [{
        id: 'r_restore_format_conflict', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
        updated_at: restoreAt, deleted_at: null,
      }],
    }, {
      rounds: [{
        ...formattedTombstone,
        id: 'r_restore_format_conflict',
        updated_at: '2026-01-02 00:00:01.124456+00:00',
      }],
    }),
    /rounds.*newer remote row/,
  )
})

test('compares all restore timestamps semantically while retaining real timestamp conflicts', async () => {
  const client = mutableClient({
    games: [{
      id: 'g_restore_payload_format', game_id: 'farkle',
      created_at: '2026-01-01 00:00:00.123456+00:00',
      updated_at: '2026-01-02 00:00:01.123456+00:00',
      finished_at: '2026-01-02 00:00:00.654321+00:00',
      settings: { rounds: 10 }, deleted_at: '2026-01-02 00:00:00.000000+00:00',
    }],
  })

  const restore = {
    id: 'g_restore_payload_format', game_id: 'farkle',
    created_at: '2026-01-01T00:00:00.123Z',
    updated_at: '2026-01-03T00:00:00.000Z',
    finished_at: '2026-01-02T00:00:00.654Z',
    settings: { rounds: 10 }, deleted_at: null,
  }
  await createCloudApi(client).restoreRows({ games: [restore] }, {
    games: [{
      id: 'g_restore_payload_format',
      updated_at: '2026-01-02T00:00:01.123456Z',
      deleted_at: '2026-01-02T00:00:00.000Z',
    }],
  })
  assert.equal(client.rows('games')[0].deleted_at, null)

  const changedTimestampClient = mutableClient({
    games: [{
      id: 'g_restore_payload_conflict', game_id: 'farkle',
      created_at: '2026-01-01 00:00:00.123456+00:00',
      updated_at: '2026-01-02 00:00:01.123456+00:00',
      finished_at: '2026-01-02 00:00:00.654321+00:00',
      settings: { rounds: 10 }, deleted_at: '2026-01-02 00:00:00.000000+00:00',
    }],
  })
  await assert.rejects(
    createCloudApi(changedTimestampClient).restoreRows({ games: [{
      ...restore,
      id: 'g_restore_payload_conflict',
      finished_at: '2026-01-02T00:00:00.655Z',
    }] }, {
      games: [{
        id: 'g_restore_payload_conflict',
        updated_at: '2026-01-02T00:00:01.123456Z',
        deleted_at: '2026-01-02T00:00:00.000Z',
      }],
    }),
    /games.*newer remote row/,
  )
})

test('restores game and composite player tombstones through the same conditional path', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const serverAt = '2026-01-02T00:00:01.000Z'
  const restoreAt = '2026-01-02T00:00:02.000Z'
  const client = mutableClient({
    games: [{
      id: 'g_restore', game_id: 'farkle', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: serverAt, finished_at: null, settings: {}, deleted_at: deletedAt,
    }],
    game_players: [{
      game_id: 'g_restore', person_id: 'p_restore', seat_order: 2, name_snapshot: 'Restore',
      updated_at: serverAt, deleted_at: deletedAt,
    }],
  })

  const result = await createCloudApi(client).restoreRows({
    games: [{
      id: 'g_restore', game_id: 'farkle', created_at: '2026-01-01T00:00:00.000Z',
      updated_at: restoreAt, finished_at: null, settings: {}, deleted_at: null,
    }],
    gamePlayers: [{
      game_id: 'g_restore', person_id: 'p_restore', seat_order: 2, name_snapshot: 'Restore',
      updated_at: restoreAt, deleted_at: null,
    }],
  }, {
    games: [{ id: 'g_restore', updated_at: serverAt, deleted_at: deletedAt }],
    gamePlayers: [{ game_id: 'g_restore', person_id: 'p_restore', updated_at: serverAt, deleted_at: deletedAt }],
  })

  assert.equal(result.games[0].deleted_at, null)
  assert.equal(result.gamePlayers[0].deleted_at, null)
  assert.equal(client.rows('games')[0].updated_at, restoreAt)
  assert.equal(client.rows('game_players')[0].updated_at, restoreAt)
})

test('rejects restore when another device changes the tombstone after deletion', async () => {
  const deletedAt = '2026-01-02T00:00:00.000Z'
  const expectedServerAt = '2026-01-02T00:00:01.000Z'
  const changedServerAt = '2026-01-02T00:00:03.000Z'
  const client = mutableClient({
    rounds: [{
      id: 'r_restore_conflict', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 99 } },
      updated_at: changedServerAt, deleted_at: deletedAt,
    }],
  })

  await assert.rejects(
    createCloudApi(client).restoreRows({
      rounds: [{
        id: 'r_restore_conflict', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 12 } },
        updated_at: '2026-01-02T00:00:04.000Z', deleted_at: null,
      }],
    }, {
      rounds: [{ id: 'r_restore_conflict', game_id: 'g_restore', updated_at: expectedServerAt, deleted_at: deletedAt }],
    }),
    /rounds.*newer remote row/,
  )
  assert.deepEqual(client.rows('rounds')[0], {
    id: 'r_restore_conflict', game_id: 'g_restore', round_index: 3, entries: { p_one: { score: 99 } },
    updated_at: changedServerAt, deleted_at: deletedAt,
  })
})

test('rejects a stale composite game-player soft delete', async () => {
  const client = mutableClient({
    game_players: [{ game_id: 'g_one', person_id: 'p_one', updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null }],
  })

  await assert.rejects(
    createCloudApi(client).softDelete('gamePlayers', { gameId: 'g_one', personId: 'p_one' }, '2026-01-01T00:00:00.000Z'),
    /game_players.*newer remote row/,
  )
  assert.equal(client.rows('game_players')[0].deleted_at, null)
})

test('rejects same-millisecond soft deletes and accepts a newer version against a live row', async () => {
  const existingAt = '2026-01-02T00:00:00.000Z'
  const staleClient = mutableClient({
    rounds: [{ id: 'r_version_boundary', game_id: 'g_one', updated_at: existingAt, deleted_at: null }],
  })

  await assert.rejects(
    createCloudApi(staleClient).softDelete('rounds', 'r_version_boundary', existingAt),
    /Supabase rounds: (?:stale mutation|conflicting equal-version row)/,
  )
  assert.equal(staleClient.rows('rounds')[0].deleted_at, null)

  const newerAt = '2026-01-02T00:00:01.000Z'
  const newerClient = mutableClient({
    rounds: [{ id: 'r_version_boundary', game_id: 'g_one', updated_at: existingAt, deleted_at: null }],
  })
  await createCloudApi(newerClient).softDelete('rounds', 'r_version_boundary', newerAt)
  assert.equal(newerClient.rows('rounds')[0].deleted_at, newerAt)
})

test('inserts new upsert rows when no remote row exists', async () => {
  const client = mutableClient()

  await createCloudApi(client).upsertRows({ people: [{ id: 'p_new', name: 'New', updated_at: '2026-01-01T00:00:00.000Z' }] })

  assert.deepEqual(client.rows('people'), [{ id: 'p_new', name: 'New', updated_at: '2026-01-01T00:00:00.000Z' }])
  assert.deepEqual(client.calls.find((call) => call.operation === 'upsert'), {
    table: 'people', operation: 'upsert',
    payload: [{ id: 'p_new', name: 'New', updated_at: '2026-01-01T00:00:00.000Z' }],
    options: { onConflict: 'id', ignoreDuplicates: true },
  })
})

test('handles a concurrent create with ignore-duplicates and conditional reconciliation', async () => {
  const client = mutableClient({}, {
    beforeUpsert(table, payload, tableRows) {
      if (table === 'people' && payload[0]?.id === 'p_race') {
        tableRows.push({ id: 'p_race', name: 'Remote winner', updated_at: '2026-01-02T00:00:00.000Z' })
      }
    },
  })

  await assert.rejects(
    createCloudApi(client).upsertRows({ people: [{ id: 'p_race', name: 'Stale local', updated_at: '2026-01-01T00:00:00.000Z' }] }),
    /people.*newer remote row/,
  )
  assert.deepEqual(client.rows('people'), [{ id: 'p_race', name: 'Remote winner', updated_at: '2026-01-02T00:00:00.000Z' }])
  assert.deepEqual(client.calls.find((call) => call.operation === 'upsert'), {
    table: 'people', operation: 'upsert',
    payload: [{ id: 'p_race', name: 'Stale local', updated_at: '2026-01-01T00:00:00.000Z' }],
    options: { onConflict: 'id', ignoreDuplicates: true },
  })
})

test('additive upserts preserve concurrent identities and insert genuinely missing rows', async () => {
  const remoteVersion = '2026-01-01T00:00:00.000Z'
  const migrationVersion = '2026-01-03T00:00:00.000Z'
  const existing = {
    people: {
      id: 'p_race', name: 'Remote winner', updated_at: remoteVersion, deleted_at: null,
    },
    games: {
      id: 'g_race', game_id: 'farkle', created_at: remoteVersion, updated_at: remoteVersion,
      settings: { source: 'remote' }, finished_at: null, deleted_at: null,
    },
    game_players: {
      game_id: 'g_race', person_id: 'p_race', seat_order: 0, name_snapshot: 'Remote winner',
      updated_at: remoteVersion, deleted_at: null,
    },
    rounds: {
      id: 'r_race', game_id: 'g_race', round_index: 0, entries: { p_race: { score: 10 } },
      updated_at: remoteVersion, deleted_at: remoteVersion,
    },
  }
  const client = mutableClient({
    people: [existing.people],
    games: [existing.games],
    game_players: [existing.game_players],
    rounds: [existing.rounds],
  })

  await createCloudApi(client).upsertRows({
    people: [
      { ...existing.people, name: 'Stale local', updated_at: migrationVersion },
      { id: 'p_missing', name: 'Missing local', updated_at: migrationVersion, deleted_at: null },
    ],
    games: [
      { ...existing.games, settings: { source: 'local' }, updated_at: migrationVersion },
      { ...existing.games, id: 'g_missing', settings: {}, updated_at: migrationVersion },
    ],
    gamePlayers: [
      { ...existing.game_players, name_snapshot: 'Stale local', updated_at: migrationVersion },
      { ...existing.game_players, person_id: 'p_missing', name_snapshot: 'Missing local', updated_at: migrationVersion },
    ],
    rounds: [
      { ...existing.rounds, entries: { p_race: { score: 99 } }, deleted_at: null, updated_at: migrationVersion },
      { ...existing.rounds, id: 'r_missing', entries: { p_race: { score: 20 } }, deleted_at: null, updated_at: migrationVersion },
    ],
  }, { additive: true })

  assert.deepEqual(client.rows('people').find(({ id }) => id === existing.people.id), existing.people)
  assert.deepEqual(client.rows('games').find(({ id }) => id === existing.games.id), existing.games)
  assert.deepEqual(client.rows('game_players').find(({ person_id }) => person_id === existing.game_players.person_id), existing.game_players)
  assert.deepEqual(client.rows('rounds').find(({ id }) => id === existing.rounds.id), existing.rounds)
  assert.ok(client.rows('people').some(({ id }) => id === 'p_missing'))
  assert.ok(client.rows('games').some(({ id }) => id === 'g_missing'))
  assert.ok(client.rows('game_players').some(({ person_id }) => person_id === 'p_missing'))
  assert.ok(client.rows('rounds').some(({ id }) => id === 'r_missing'))
})

test('conditionally reconciles a concurrent older create with the local newer row', async () => {
  const client = mutableClient({}, {
    beforeUpsert(table, payload, tableRows) {
      if (table === 'people' && payload[0]?.id === 'p_older_race') {
        tableRows.push({ id: 'p_older_race', name: 'Older remote', updated_at: '2026-01-01T00:00:00.000Z' })
      }
    },
  })

  await createCloudApi(client).upsertRows({ people: [{
    id: 'p_older_race', name: 'New local', updated_at: '2026-01-02T00:00:00.000Z',
  }] })

  assert.deepEqual(client.rows('people'), [{
    id: 'p_older_race', name: 'New local', updated_at: '2026-01-02T00:00:00.000Z',
  }])
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
