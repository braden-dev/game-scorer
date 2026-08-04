const TABLES = [
  { key: 'people', table: 'people', conflict: 'id' },
  { key: 'games', table: 'games', conflict: 'id' },
  { key: 'gamePlayers', table: 'game_players', conflict: 'game_id,person_id' },
  { key: 'rounds', table: 'rounds', conflict: 'id' },
]

const ENTITY_TABLES = {
  people: { table: 'people', keys: [['id', 'id']] },
  games: { table: 'games', keys: [['id', 'id']] },
  gamePlayers: { table: 'game_players', keys: [['game_id', 'gameId'], ['person_id', 'personId']] },
  rounds: { table: 'rounds', keys: [['id', 'id']] },
}

function providerMessage(error) {
  if (error && typeof error === 'object' && 'message' in error) return error.message
  return String(error)
}

async function checked(response, table) {
  const result = await response
  if (result?.error) throw new Error(`Supabase ${table}: ${providerMessage(result.error)}`)
  return result?.data ?? null
}

async function readTable(client, { key, table }, since = null) {
  let query = client.from(table).select('*')
  if (since !== null) query = query.gte('updated_at', since)
  const data = await checked(query, table)
  return [key, Array.isArray(data) ? data : []]
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
        if (!payload.length) continue
        await checked(
          client.from(definition.table).upsert(payload, { onConflict: definition.conflict }),
          definition.table,
        )
      }
    },

    async fetchRowsUpdatedSince(isoTimestamp) {
      const entries = await Promise.all(TABLES.map((definition) => readTable(client, definition, isoTimestamp)))
      return Object.fromEntries(entries)
    },

    async softDelete(entity, id, updatedAt) {
      const definition = entityDefinition(entity)
      if (!definition) throw new Error(`Unknown cloud entity: ${entity}`)

      let query = client.from(definition.table).update({ deleted_at: updatedAt, updated_at: updatedAt })
      for (const [column, camelName] of definition.keys) {
        const value = entityValue(id, camelName, column)
        if (value === undefined || value === null) throw new Error(`Missing ${column} for ${definition.table} soft delete`)
        query = query.eq(column, value)
      }
      await checked(query, definition.table)
    },
  }
}
