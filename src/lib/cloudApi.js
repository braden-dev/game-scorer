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

function rowVersion(row) {
  const versions = [timestamp(row?.updated_at), timestamp(row?.deleted_at)].filter((value) => value !== null)
  return versions.length ? Math.max(...versions) : Number.NEGATIVE_INFINITY
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

async function checkedWrite(query, table, action) {
  const data = await checked(query, table)
  const matched = Array.isArray(data) ? data.length > 0 : data != null
  if (!matched) throw conflictError(table)
  return data
}

async function insertRow(client, definition, row) {
  await checkedWrite(
    client.from(definition.table).insert([row]).select(selectedKeys(definition)),
    definition.table,
    'insert',
  )
}

async function compareAndSetRow(client, definition, row, existing) {
  if (rowVersion(existing) > rowVersion(row)) throw conflictError(definition.table)

  let query = keyFilters(client.from(definition.table).update(row), definition, row)
  const expectedUpdatedAt = existing.updated_at
  query = expectedUpdatedAt === null || expectedUpdatedAt === undefined
    ? query.is('updated_at', null)
    : query.eq('updated_at', expectedUpdatedAt)
  await checkedWrite(query.select(selectedKeys(definition)), definition.table, 'update')
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

    async upsertRows(rows = {}) {
      for (const definition of TABLES) {
        const payload = Array.isArray(rows[definition.key]) ? rows[definition.key] : []
        for (const row of payload) {
          const existing = await findExisting(client, definition, row)
          if (existing) await compareAndSetRow(client, definition, row, existing)
          else await insertRow(client, definition, row)
        }
      }
    },

    async fetchRowsUpdatedSince(isoTimestamp) {
      const entries = await Promise.all(TABLES.map((definition) => readTable(client, definition, isoTimestamp)))
      return Object.fromEntries(entries)
    },

    async softDelete(entity, id, updatedAt) {
      const definition = entityDefinition(entity)
      if (!definition) throw new Error(`Unknown cloud entity: ${entity}`)

      const requestedVersion = timestamp(updatedAt)
      let query = client.from(definition.table).select('*')
      query = keyFilters(query, definition, typeof id === 'object' ? id : { id })
      const data = await checked(query, definition.table)
      const existing = Array.isArray(data) ? data[0] ?? null : data
      if (!existing) throw new Error(`Supabase ${definition.table}: soft delete no rows matched`)
      if (rowVersion(existing) > (requestedVersion ?? Number.NEGATIVE_INFINITY)) throw conflictError(definition.table)

      query = client.from(definition.table).update({ deleted_at: updatedAt, updated_at: updatedAt })
      for (const [column, camelName] of definition.keys) {
        const value = entityValue(id, camelName, column)
        if (value === undefined || value === null) throw new Error(`Missing ${column} for ${definition.table} soft delete`)
        query = query.eq(column, value)
      }
      query = existing.updated_at === null || existing.updated_at === undefined
        ? query.is('updated_at', null)
        : query.eq('updated_at', existing.updated_at)
      await checkedWrite(query.select(selectedKeys(definition)), definition.table, 'soft delete')
    },
  }
}
