const TABLES = [
  { key: 'people', table: 'people', conflict: 'id', orderBy: ['id'] },
  { key: 'games', table: 'games', conflict: 'id', orderBy: ['id'] },
  { key: 'gamePlayers', table: 'game_players', conflict: 'game_id,person_id', orderBy: ['game_id', 'person_id'] },
  { key: 'rounds', table: 'rounds', conflict: 'id', orderBy: ['id'] },
]

const ENTITY_TABLES = {
  people: { table: 'people', keys: [['id', 'id']] },
  games: { table: 'games', keys: [['id', 'id']] },
  gamePlayers: { table: 'game_players', keys: [['game_id', 'gameId'], ['person_id', 'personId']] },
  rounds: { table: 'rounds', keys: [['id', 'id']] },
}

const PAGE_SIZE = 1000
const TIMESTAMP_COLUMNS = new Set(['created_at', 'updated_at', 'deleted_at', 'finished_at'])
const INVALID_VERSION = Symbol('invalid row version')

function providerMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return error.message
  return String(error)
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const milliseconds = Date.parse(String(value))
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function canonicalTimestamp(value) {
  if (value === null || value === undefined) return null
  const milliseconds = timestamp(value)
  if (milliseconds === null) return { invalidTimestamp: String(value) }

  // Cloud timestamps use millisecond application precision. PostgreSQL's
  // six-digit fractional formatting is intentionally reduced to that value.
  return Math.trunc(milliseconds)
}

function rowVersion(row) {
  const versions = []
  for (const column of ['updated_at', 'deleted_at']) {
    const rawValue = row?.[column]
    if (rawValue === null || rawValue === undefined || rawValue === '') continue
    const value = timestamp(rawValue)
    if (value === null) return INVALID_VERSION
    versions.push(value)
  }
  return versions.length ? Math.max(...versions) : Number.NEGATIVE_INFINITY
}

function stableValue(value) {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (typeof value === 'object') {
    return `{${Reflect.ownKeys(value)
      .filter((key) => typeof key === 'string')
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValue(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

function samePayload(left, right) {
  return stableValue(left) === stableValue(right)
}

function canonicalPayload(row) {
  return Object.fromEntries(Reflect.ownKeys(row ?? {})
    .filter((key) => typeof key === 'string' && key !== 'updated_at')
    .sort()
    .map((key) => [key, row[key] ?? null]))
}

function canonicalComparablePayload(row, keys) {
  return Object.fromEntries(keys.map((key) => {
    const value = row?.[key] ?? null
    return [key, TIMESTAMP_COLUMNS.has(key) ? canonicalTimestamp(value) : value]
  }))
}

function sameCanonicalPayload(existing, attempted) {
  const requested = canonicalPayload(attempted)
  const keys = Object.keys(requested)
  return samePayload(
    canonicalComparablePayload(existing, keys),
    canonicalComparablePayload(attempted, keys),
  )
}

function restorePayload(row) {
  const payload = Object.fromEntries(Reflect.ownKeys(row ?? {})
    .filter((key) => typeof key === 'string' && !['updated_at', 'updatedAt', 'deleted_at', 'deletedAt'].includes(key))
    .sort()
    .map((key) => [key, row[key] ?? null]))
  return payload
}

function sameRestorePayload(existing, attempted) {
  const requested = restorePayload(attempted)
  const keys = Object.keys(requested)
  return samePayload(
    canonicalComparablePayload(existing, keys),
    canonicalComparablePayload(attempted, keys),
  )
}

function rowValue(row, column) {
  if (row?.[column] !== undefined) return row[column]
  const camel = column.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
  return row?.[camel]
}

function keyFilters(query, definition, row) {
  let next = query
  for (const [column] of definition.keys ?? definition.conflict.split(',').map((column) => [column])) {
    const value = rowValue(row, column)
    if (value === undefined || value === null) throw new Error(`Missing ${column} for ${definition.table} write`)
    next = next.eq(column, value)
  }
  return next
}

function selectedKeys(definition) {
  return (definition.keys ?? definition.conflict.split(',').map((column) => [column])).map(([column]) => column).join(',')
}

function sameEntityKey(definition, left, right) {
  return (definition.keys ?? definition.conflict.split(',').map((column) => [column]))
    .every(([column]) => rowValue(left, column) === rowValue(right, column))
}

async function checked(response, table) {
  let result
  try {
    result = await response
  } catch (error) {
    throw new Error(`Supabase ${table}: ${providerMessage(error)}`)
  }
  if (result?.error) throw new Error(`Supabase ${table}: ${providerMessage(result.error)}`)
  return result?.data ?? null
}

async function readTable(client, { key, table, orderBy = ['id'] }, since = null) {
  const allRows = []
  for (let start = 0; ; start += PAGE_SIZE) {
    let query = client.from(table).select('*')
    if (since !== null) query = query.gte('updated_at', since)
    for (const column of orderBy) {
      query = query.order(column, { ascending: true })
    }
    query = query.range(start, start + PAGE_SIZE - 1)
    const data = await checked(query, table)
    const page = Array.isArray(data) ? data : []
    allRows.push(...page)
    if (page.length < PAGE_SIZE) break
  }
  return [key, allRows]
}

async function findExisting(client, definition, row) {
  const query = keyFilters(client.from(definition.table).select('*'), definition, row)
  const data = await checked(query, definition.table)
  return Array.isArray(data) ? data[0] ?? null : data
}

function conflictError(table) {
  return new Error(`Supabase ${table}: stale mutation; newer remote row exists`)
}

function equalVersionConflictError(table) {
  return new Error(`Supabase ${table}: conflicting equal-version row`)
}

function assertValidVersion(table, version) {
  if (version === INVALID_VERSION) throw new Error(`Supabase ${table}: invalid timestamp in row version`)
}

async function checkedWrite(query, table, action) {
  const data = await checked(query, table)
  const matched = Array.isArray(data) ? data.length > 0 : data != null
  if (!matched) throw conflictError(table)
  return data
}

async function compareAndSetRow(client, definition, row, existing) {
  const existingVersion = rowVersion(existing)
  const requestedVersion = rowVersion(row)
  assertValidVersion(definition.table, existingVersion)
  assertValidVersion(definition.table, requestedVersion)
  if (existingVersion > requestedVersion) {
    if (sameCanonicalPayload(existing, row)) return existing
    throw conflictError(definition.table)
  }
  if (Number.isFinite(existingVersion) && existingVersion === requestedVersion) {
    if (!sameCanonicalPayload(existing, row)) throw equalVersionConflictError(definition.table)
    return existing
  }

  let query = keyFilters(client.from(definition.table).update(row), definition, row)
  const expectedUpdatedAt = existing.updated_at
  query = expectedUpdatedAt === null || expectedUpdatedAt === undefined
    ? query.is('updated_at', null)
    : query.eq('updated_at', expectedUpdatedAt)
  const data = await checkedWrite(query.select('*'), definition.table, 'update')
  return Array.isArray(data) ? data[0] ?? existing : data ?? existing
}

async function upsertWithoutOverwriting(client, definition, row, { additive = false } = {}) {
  assertValidVersion(definition.table, rowVersion(row))
  await checked(
    client.from(definition.table).upsert([row], {
      onConflict: definition.conflict,
      ignoreDuplicates: true,
    }),
    definition.table,
  )
  const existing = await findExisting(client, definition, row)
  if (!existing) throw conflictError(definition.table)
  return additive ? existing : compareAndSetRow(client, definition, row, existing)
}

async function restoreRow(client, definition, row, expectedTombstone) {
  const requestedVersion = rowVersion(row)
  assertValidVersion(definition.table, requestedVersion)
  const existing = await findExisting(client, definition, row)
  if (!existing) throw conflictError(definition.table)
  const existingVersion = rowVersion(existing)
  assertValidVersion(definition.table, existingVersion)

  const existingDeletedAt = canonicalTimestamp(existing.deleted_at)
  if (existingDeletedAt === null) {
    if (sameRestorePayload(existing, row)) return existing
    throw conflictError(definition.table)
  }

  const existingUpdatedAt = canonicalTimestamp(existing.updated_at)
  const expectedDeletedAt = canonicalTimestamp(rowValue(expectedTombstone, 'deleted_at'))
  const expectedUpdatedAt = canonicalTimestamp(rowValue(expectedTombstone, 'updated_at'))
  if (expectedDeletedAt === null || expectedUpdatedAt === null) throw conflictError(definition.table)
  if (existingDeletedAt !== expectedDeletedAt
    || existingUpdatedAt !== expectedUpdatedAt
    || !sameRestorePayload(existing, row)) {
    throw conflictError(definition.table)
  }

  let query = keyFilters(client.from(definition.table).update({ ...row, deleted_at: null }), definition, row)
  query = query.eq('deleted_at', existing.deleted_at)
  query = query.eq('updated_at', existing.updated_at)
  const data = await checkedWrite(query.select('*'), definition.table, 'restore')
  return Array.isArray(data) ? data[0] ?? existing : data ?? existing
}

function entityDefinition(entity) {
  if (entity === 'game_players') return ENTITY_TABLES.gamePlayers
  return ENTITY_TABLES[entity]
}

function entityValue(id, camelName, snakeName) {
  if (id && typeof id === 'object') return id[camelName] ?? id[snakeName]
  if (camelName === 'id') return id
  return undefined
}

export function createCloudApi(client) {
  if (!client) throw new Error('Supabase client is required')

  return {
    async fetchSnapshot() {
      const entries = await Promise.all(TABLES.map((definition) => readTable(client, definition)))
      return Object.fromEntries(entries)
    },

    async upsertRows(rows = {}, { additive = false } = {}) {
      const canonicalRows = Object.fromEntries(TABLES.map((definition) => [definition.key, []]))
      for (const definition of TABLES) {
        const payload = Array.isArray(rows[definition.key]) ? rows[definition.key] : []
        for (const row of payload) {
          const requestedVersion = rowVersion(row)
          assertValidVersion(definition.table, requestedVersion)
          const existing = await findExisting(client, definition, row)
          if (existing) {
            const existingVersion = rowVersion(existing)
            assertValidVersion(definition.table, existingVersion)
            if (!additive && existingVersion > requestedVersion && !sameCanonicalPayload(existing, row)) {
              throw conflictError(definition.table)
            }
          }
          canonicalRows[definition.key].push(await upsertWithoutOverwriting(client, definition, row, { additive }))
        }
      }
      return canonicalRows
    },

    async restoreRows(rows = {}, expectedTombstones = {}) {
      const canonicalRows = Object.fromEntries(TABLES.map((definition) => [definition.key, []]))
      for (const definition of TABLES) {
        const payload = Array.isArray(rows[definition.key]) ? rows[definition.key] : []
        const expectedRows = Array.isArray(expectedTombstones[definition.key])
          ? expectedTombstones[definition.key]
          : []
        const positionColumn = definition.key === 'rounds'
          ? 'round_index'
          : definition.key === 'gamePlayers' ? 'seat_order' : null
        const orderedRows = payload
          .map((row) => ({
            row,
            expectedTombstone: expectedRows.find((candidate) => sameEntityKey(definition, candidate, row)),
          }))
          .sort((left, right) => {
            const expectedOrder = Number(Boolean(left.expectedTombstone)) - Number(Boolean(right.expectedTombstone))
            if (expectedOrder !== 0) return expectedOrder
            if (!positionColumn) return 0
            return (Number(rowValue(right.row, positionColumn)) || 0) - (Number(rowValue(left.row, positionColumn)) || 0)
          })
        for (const { row, expectedTombstone } of orderedRows) {
          canonicalRows[definition.key].push(expectedTombstone
            ? await restoreRow(client, definition, row, expectedTombstone)
            : await upsertWithoutOverwriting(client, definition, row))
        }
      }
      return canonicalRows
    },

    async fetchRowsUpdatedSince(isoTimestamp) {
      const entries = await Promise.all(TABLES.map((definition) => readTable(client, definition, isoTimestamp)))
      return Object.fromEntries(entries)
    },

    async softDelete(entity, id, updatedAt) {
      const definition = entityDefinition(entity)
      if (!definition) throw new Error(`Unknown cloud entity: ${entity}`)

      const requestedVersion = timestamp(updatedAt)
      assertValidVersion(definition.table, rowVersion({ updated_at: updatedAt }))
      let query = client.from(definition.table).select('*')
      query = keyFilters(query, definition, typeof id === 'object' ? id : { id })
      const data = await checked(query, definition.table)
      const existing = Array.isArray(data) ? data[0] ?? null : data
      if (!existing) throw new Error(`Supabase ${definition.table}: soft delete no rows matched`)
      const existingVersion = rowVersion(existing)
      assertValidVersion(definition.table, existingVersion)
      const requestedVersionValue = requestedVersion ?? Number.NEGATIVE_INFINITY
      if (requestedVersion !== null && timestamp(existing.deleted_at) === requestedVersion) return existing
      if (existingVersion > requestedVersionValue) {
        throw conflictError(definition.table)
      }
      if (Number.isFinite(requestedVersion) && existingVersion === requestedVersion) {
        const alreadyDeleted = timestamp(existing.deleted_at) === requestedVersion
        if (alreadyDeleted) return existing
        throw equalVersionConflictError(definition.table)
      }

      query = client.from(definition.table).update({ deleted_at: updatedAt, updated_at: updatedAt })
      for (const [column, camelName] of definition.keys) {
        const value = entityValue(id, camelName, column)
        if (value === undefined || value === null) throw new Error(`Missing ${column} for ${definition.table} soft delete`)
        query = query.eq(column, value)
      }
      query = existing.updated_at === null || existing.updated_at === undefined
        ? query.is('updated_at', null)
        : query.eq('updated_at', existing.updated_at)
      const result = await checkedWrite(query.select('*'), definition.table, 'soft delete')
      return Array.isArray(result) ? result[0] ?? existing : result ?? existing
    },
  }
}
