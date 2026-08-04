const KEY = 'gamescorer.cloud.v1'
const CLOUD_METADATA = Symbol.for('gamescorer.cloudMetadata')
const SERIALIZED_METADATA_KEY = '__cloudMetadata'

const EMPTY_CACHE = { games: [], roster: [], activeGameId: null }
const EMPTY_STORE = {
  cache: EMPTY_CACHE,
  outbox: [],
  lastSyncAt: null,
  lastError: null,
  initialMigrationCompleted: false,
}

function storageOrDefault(storage) {
  if (storage !== undefined) return storage
  try {
    return globalThis?.localStorage ?? globalThis?.window?.localStorage ?? null
  } catch {
    return null
  }
}

function clone(value) {
  if (value && typeof value === 'object') {
    const copy = Array.isArray(value) ? [] : {}
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if ('value' in descriptor) descriptor.value = clone(descriptor.value)
      Object.defineProperty(copy, key, descriptor)
    }
    return copy
  }
  return value
}

function normalizeCache(cache) {
  const normalized = cache && typeof cache === 'object' ? clone(cache) : {}
  delete normalized[SERIALIZED_METADATA_KEY]
  normalized.games = Array.isArray(cache?.games) ? clone(cache.games) : []
  normalized.roster = Array.isArray(cache?.roster) ? clone(cache.roster) : []
  normalized.activeGameId = cache?.activeGameId ?? null
  return normalized
}

function normalizeStore(store) {
  return {
    cache: normalizeCache(store?.cache),
    outbox: Array.isArray(store?.outbox) ? clone(store.outbox) : [],
    lastSyncAt: store?.lastSyncAt ?? null,
    lastError: store?.lastError ?? null,
    initialMigrationCompleted: Boolean(store?.initialMigrationCompleted),
  }
}

function emptyStore() {
  return clone(EMPTY_STORE)
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return validMilliseconds(value)
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text)
    return validMilliseconds(milliseconds)
  }
  const milliseconds = Date.parse(text)
  return validMilliseconds(milliseconds)
}

function validMilliseconds(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? milliseconds : null
}

function recordField(record, camelName, snakeName) {
  return record?.[camelName] ?? record?.[snakeName]
}

function version(record, fallback = 0) {
  const updatedAt = timestamp(recordField(record, 'updatedAt', 'updated_at')) ?? fallback
  const deletedAt = timestamp(recordField(record, 'deletedAt', 'deleted_at'))
  return Math.max(updatedAt, deletedAt ?? Number.NEGATIVE_INFINITY)
}

function isTombstone(record) {
  return recordField(record, 'deletedAt', 'deleted_at') != null
}

function withoutTombstone(record) {
  if (!record || typeof record !== 'object') return record
  const next = clone(record)
  delete next.deletedAt
  delete next.deleted_at
  return next
}

function indexRecords(records, fallback) {
  const indexed = new Map()
  for (const record of records) {
    if (record?.id == null) continue
    const previous = indexed.get(record.id)
    if (!previous || version(record, fallback) >= version(previous, fallback)) indexed.set(record.id, record)
  }
  return indexed
}

function mergeRecords(localRecords, remoteRecords, remoteFallback = 0, localFallback = 0) {
  const local = Array.isArray(localRecords) ? localRecords : []
  const remote = Array.isArray(remoteRecords) ? remoteRecords : []
  const localById = indexRecords(local, localFallback)
  const remoteById = indexRecords(remote, remoteFallback)
  const ids = [...localById.keys(), ...remoteById.keys().filter((id) => !localById.has(id))]
  const merged = []

  for (const id of ids) {
    const localRecord = localById.get(id)
    const remoteRecord = remoteById.get(id)
    let chosen

    if (!localRecord) {
      if (isTombstone(remoteRecord)) continue
      chosen = remoteRecord
    } else if (!remoteRecord) {
      if (isTombstone(localRecord)) continue
      chosen = localRecord
    } else {
      chosen = version(remoteRecord, remoteFallback) >= version(localRecord, localFallback) ? remoteRecord : localRecord
      if (isTombstone(chosen)) continue
    }

    merged.push(withoutTombstone(chosen))
  }

  return merged
}

function metadataFor(state) {
  return state?.[CLOUD_METADATA] ?? {}
}

function setMetadata(state, metadata) {
  Object.defineProperty(state, CLOUD_METADATA, {
    value: metadata,
    configurable: true,
  })
  return state
}

function metadataRecords(metadata, key) {
  return Array.isArray(metadata?.[key]) ? metadata[key] : []
}

function childMetadata(metadata, key, gameId) {
  return metadataRecords(metadata, key).filter((record) => record.gameId === gameId)
}

function metadataOrder(record, camelName, snakeName) {
  const value = recordField(record, camelName, snakeName)
  if (value === null || value === undefined || value === '') return null
  const order = Number(value)
  return Number.isFinite(order) ? order : null
}

function sortByMetadata(records, camelName, snakeName) {
  return records
    .map((record, index) => ({ record, index, order: metadataOrder(record, camelName, snakeName) }))
    .sort((left, right) => {
      if (left.order === null && right.order === null) return left.index - right.index
      if (left.order === null) return 1
      if (right.order === null) return -1
      return left.order - right.order || left.index - right.index
    })
    .map(({ record }) => record)
}

function withVersion(record, updatedAt, createdAt = undefined) {
  Object.defineProperty(record, 'updatedAt', {
    value: updatedAt,
    configurable: true,
    writable: true,
  })
  if (createdAt !== undefined) {
    Object.defineProperty(record, 'createdAt', {
      value: createdAt,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function withPlayerMetadata(record, seatOrder, nameSnapshot) {
  if (seatOrder !== undefined) {
    Object.defineProperty(record, 'seatOrder', {
      value: seatOrder,
      configurable: true,
      writable: true,
    })
  }
  if (nameSnapshot !== undefined) {
    Object.defineProperty(record, 'nameSnapshot', {
      value: nameSnapshot,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function withRoundMetadata(record, roundIndex) {
  if (roundIndex !== undefined) {
    Object.defineProperty(record, 'roundIndex', {
      value: roundIndex,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function serializableRecord(record) {
  const serialized = {}
  for (const key of Object.keys(record ?? {})) serialized[key] = clone(record[key])
  const createdAt = recordField(record, 'createdAt', 'created_at')
  const updatedAt = recordField(record, 'updatedAt', 'updated_at')
  const deletedAt = recordField(record, 'deletedAt', 'deleted_at')
  if (record?.gameId !== undefined) serialized.gameId = record.gameId
  if (createdAt !== undefined) serialized.createdAt = createdAt
  if (updatedAt !== undefined) serialized.updatedAt = updatedAt
  if (deletedAt !== undefined) serialized.deletedAt = deletedAt
  const seatOrder = recordField(record, 'seatOrder', 'seat_order')
  const nameSnapshot = recordField(record, 'nameSnapshot', 'name_snapshot')
  const roundIndex = recordField(record, 'roundIndex', 'round_index')
  if (seatOrder !== undefined) serialized.seatOrder = seatOrder
  if (nameSnapshot !== undefined) serialized.nameSnapshot = nameSnapshot
  if (roundIndex !== undefined) serialized.roundIndex = roundIndex
  return serialized
}

function cacheVersionEntries(cache) {
  const roster = cache.roster
    .map((person) => ({
      id: person.id,
      createdAt: recordField(person, 'createdAt', 'created_at'),
      updatedAt: recordField(person, 'updatedAt', 'updated_at'),
    }))
    .filter((person) => person.createdAt != null || person.updatedAt != null)
  const gamePlayers = cache.games.flatMap((game) => (Array.isArray(game.players) ? game.players : [])
    .map((player) => ({
      gameId: game.id,
      id: player.id,
      updatedAt: recordField(player, 'updatedAt', 'updated_at'),
      seatOrder: recordField(player, 'seatOrder', 'seat_order'),
      nameSnapshot: recordField(player, 'nameSnapshot', 'name_snapshot'),
    }))
    .filter((player) => player.updatedAt != null || player.seatOrder != null || player.nameSnapshot != null))
  const rounds = cache.games.flatMap((game) => (Array.isArray(game.rounds) ? game.rounds : [])
    .map((round) => ({
      gameId: game.id,
      id: round.id,
      updatedAt: recordField(round, 'updatedAt', 'updated_at'),
      roundIndex: recordField(round, 'roundIndex', 'round_index'),
    }))
    .filter((round) => round.updatedAt != null || round.roundIndex != null))
  return { roster, gamePlayers, rounds }
}

function metadataSnapshot(cache) {
  const metadata = metadataFor(cache)
  const versions = cacheVersionEntries(cache)
  return {
    roster: metadataRecords(metadata, 'roster').map(serializableRecord),
    games: metadataRecords(metadata, 'games').map(serializableRecord),
    gamePlayers: metadataRecords(metadata, 'gamePlayers').map(serializableRecord),
    rounds: metadataRecords(metadata, 'rounds').map(serializableRecord),
    versions,
  }
}

function serializeCache(cache) {
  const serialized = clone(cache)
  serialized[SERIALIZED_METADATA_KEY] = metadataSnapshot(cache)
  return serialized
}

function restoreCache(cache, serializedMetadata) {
  const restored = normalizeCache(cache)
  if (!serializedMetadata || typeof serializedMetadata !== 'object') return restored

  const metadata = {
    roster: Array.isArray(serializedMetadata.roster) ? clone(serializedMetadata.roster) : [],
    games: Array.isArray(serializedMetadata.games) ? clone(serializedMetadata.games) : [],
    gamePlayers: Array.isArray(serializedMetadata.gamePlayers) ? clone(serializedMetadata.gamePlayers) : [],
    rounds: Array.isArray(serializedMetadata.rounds) ? clone(serializedMetadata.rounds) : [],
  }
  for (const record of metadata.gamePlayers) {
    if (record.updatedAt != null) withVersion(record, record.updatedAt)
    withPlayerMetadata(record, record.seatOrder, record.nameSnapshot)
  }
  for (const record of metadata.rounds) {
    if (record.updatedAt != null) withVersion(record, record.updatedAt)
    withRoundMetadata(record, record.roundIndex)
  }
  const versions = serializedMetadata.versions ?? {}

  for (const entry of Array.isArray(versions.roster) ? versions.roster : []) {
    const record = restored.roster.find((person) => person.id === entry.id)
    if (record && (entry.createdAt != null || entry.updatedAt != null)) withVersion(record, entry.updatedAt, entry.createdAt)
  }
  for (const entry of Array.isArray(versions.gamePlayers) ? versions.gamePlayers : []) {
    const game = restored.games.find((candidate) => candidate.id === entry.gameId)
    const record = game?.players?.find((player) => player.id === entry.id)
    if (record) {
      if (entry.updatedAt != null) withVersion(record, entry.updatedAt)
      withPlayerMetadata(record, entry.seatOrder, entry.nameSnapshot)
    }
  }
  for (const entry of Array.isArray(versions.rounds) ? versions.rounds : []) {
    const game = restored.games.find((candidate) => candidate.id === entry.gameId)
    const record = game?.rounds?.find((round) => round.id === entry.id)
    if (record) {
      if (entry.updatedAt != null) withVersion(record, entry.updatedAt)
      withRoundMetadata(record, entry.roundIndex)
    }
  }

  return setMetadata(restored, metadata)
}

function mergeGame(localGame, remoteGame, lastSyncAt, localMetadata, remoteMetadata, parentPresent = true) {
  const remoteGameId = remoteGame?.id ?? localGame?.id
  const remoteFallback = parentPresent
    ? timestamp(recordField(remoteGame, 'updatedAt', 'updated_at')) ?? lastSyncAt ?? 0
    : lastSyncAt ?? 0
  const localFallback = timestamp(recordField(localGame, 'updatedAt', 'updated_at')) ?? 0
  const game = parentPresent && version(remoteGame, remoteFallback) >= version(localGame, localFallback)
    ? remoteGame
    : localGame
  if (isTombstone(game)) return null

  const merged = withoutTombstone(game)
  merged.players = mergeRecords(
    [...(localGame?.players ?? []), ...childMetadata(localMetadata, 'gamePlayers', localGame?.id)],
    [...(remoteGame?.players ?? []), ...childMetadata(remoteMetadata, 'gamePlayers', remoteGameId)],
    remoteFallback,
    localFallback,
  )
  merged.rounds = mergeRecords(
    [...(localGame?.rounds ?? []), ...childMetadata(localMetadata, 'rounds', localGame?.id)],
    [...(remoteGame?.rounds ?? []), ...childMetadata(remoteMetadata, 'rounds', remoteGameId)],
    remoteFallback,
    localFallback,
  )
  merged.players = merged.players.map((player) => {
    const visible = clone(player)
    delete visible.gameId
    return visible
  })
  merged.rounds = merged.rounds.map((round) => {
    const visible = clone(round)
    delete visible.gameId
    return visible
  })
  merged.players = sortByMetadata(merged.players, 'seatOrder', 'seat_order')
  merged.rounds = sortByMetadata(merged.rounds, 'roundIndex', 'round_index')
  return merged
}

function mergeGames(localGames, remoteGames, lastSyncAt, localMetadata, remoteMetadata) {
  const local = Array.isArray(localGames) ? localGames : []
  const remote = Array.isArray(remoteGames) ? remoteGames : []
  const localById = indexRecords(local, 0)
  const remoteById = indexRecords(remote, lastSyncAt)
  const ids = [...localById.keys(), ...remoteById.keys().filter((id) => !localById.has(id))]
  const merged = []

  for (const id of ids) {
    const localGame = localById.get(id)
    const remoteGame = remoteById.get(id)
    if (!localGame) {
      if (!isTombstone(remoteGame)) merged.push(withoutTombstone(remoteGame))
      continue
    }
    if (!remoteGame) {
      const hasRemoteChildren = childMetadata(remoteMetadata, 'gamePlayers', id).length > 0
        || childMetadata(remoteMetadata, 'rounds', id).length > 0
      if (hasRemoteChildren) {
        const game = mergeGame(localGame, null, lastSyncAt, localMetadata, remoteMetadata, false)
        if (game) merged.push(game)
      } else if (!isTombstone(localGame)) merged.push(withoutTombstone(localGame))
      continue
    }

    const game = mergeGame(localGame, remoteGame, lastSyncAt, localMetadata, remoteMetadata)
    if (game) merged.push(game)
  }

  return merged
}

export function loadSyncStore(storage) {
  try {
    const raw = storageOrDefault(storage)?.getItem(KEY)
    if (!raw) return emptyStore()
    const parsed = JSON.parse(raw)
    const normalized = normalizeStore(parsed)
    return { ...normalized, cache: restoreCache(normalized.cache, parsed?.cache?.[SERIALIZED_METADATA_KEY]) }
  } catch {
    return emptyStore()
  }
}

export function saveSyncStore(store, storage) {
  const normalized = normalizeStore(store)
  try {
    const serializable = { ...normalized, cache: serializeCache(normalized.cache) }
    storageOrDefault(storage)?.setItem(KEY, JSON.stringify(serializable))
  } catch {
    // Local persistence is best effort; the caller still has the normalized copy.
  }
  return normalized
}

export function enqueueMutation(store, mutation) {
  const normalized = normalizeStore(store)
  if (normalized.outbox.some((entry) => entry?.id === mutation?.id)) return normalized
  return {
    ...normalized,
    outbox: [...normalized.outbox, clone(mutation)],
  }
}

export function removeMutation(store, mutationId) {
  const normalized = normalizeStore(store)
  return {
    ...normalized,
    outbox: normalized.outbox.filter((mutation) => mutation?.id !== mutationId),
  }
}

export function mergeRemoteState(localState, remoteState, lastSyncAt = null) {
  const local = normalizeCache(localState)
  const remote = remoteState && typeof remoteState === 'object' ? remoteState : {}
  const syncFallback = timestamp(lastSyncAt) ?? 0
  const localMetadata = metadataFor(local)
  const remoteMetadata = metadataFor(remote)
  const localRoster = [...local.roster, ...metadataRecords(localMetadata, 'roster')]
  const remoteRoster = [...(Array.isArray(remote.roster) ? remote.roster : []), ...metadataRecords(remoteMetadata, 'roster')]
  const localGames = [...local.games, ...metadataRecords(localMetadata, 'games')]
  const remoteGames = [...(Array.isArray(remote.games) ? remote.games : []), ...metadataRecords(remoteMetadata, 'games')]
  const merged = {
    ...local,
    roster: mergeRecords(localRoster, remoteRoster, syncFallback),
    games: mergeGames(localGames, remoteGames, syncFallback, localMetadata, remoteMetadata),
    activeGameId: local.activeGameId,
  }

  Object.defineProperty(merged, CLOUD_METADATA, {
    value: {
      roster: [...metadataRecords(localMetadata, 'roster'), ...metadataRecords(remoteMetadata, 'roster')],
      games: [...metadataRecords(localMetadata, 'games'), ...metadataRecords(remoteMetadata, 'games')],
      gamePlayers: [...metadataRecords(localMetadata, 'gamePlayers'), ...metadataRecords(remoteMetadata, 'gamePlayers')],
      rounds: [...metadataRecords(localMetadata, 'rounds'), ...metadataRecords(remoteMetadata, 'rounds')],
    },
    configurable: true,
  })
  return merged
}
