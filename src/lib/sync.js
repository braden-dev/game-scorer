const KEY = 'gamescorer.cloud.v1'
const CLOUD_METADATA = Symbol.for('gamescorer.cloudMetadata')

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

function metadataRecords(metadata, key) {
  return Array.isArray(metadata?.[key]) ? metadata[key] : []
}

function childMetadata(metadata, key, gameId) {
  return metadataRecords(metadata, key).filter((record) => record.gameId === gameId)
}

function mergeGame(localGame, remoteGame, lastSyncAt, localMetadata, remoteMetadata) {
  const remoteFallback = timestamp(recordField(remoteGame, 'updatedAt', 'updated_at')) ?? lastSyncAt ?? 0
  const localFallback = timestamp(recordField(localGame, 'updatedAt', 'updated_at')) ?? 0
  const game = version(remoteGame, remoteFallback) >= version(localGame)
    ? remoteGame
    : localGame
  if (isTombstone(game)) return null

  const merged = withoutTombstone(game)
  merged.players = mergeRecords(
    [...(localGame?.players ?? []), ...childMetadata(localMetadata, 'gamePlayers', localGame?.id)],
    [...(remoteGame?.players ?? []), ...childMetadata(remoteMetadata, 'gamePlayers', remoteGame?.id)],
    remoteFallback,
    localFallback,
  )
  merged.rounds = mergeRecords(
    [...(localGame?.rounds ?? []), ...childMetadata(localMetadata, 'rounds', localGame?.id)],
    [...(remoteGame?.rounds ?? []), ...childMetadata(remoteMetadata, 'rounds', remoteGame?.id)],
    remoteFallback,
    localFallback,
  )
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
      if (!isTombstone(localGame)) merged.push(withoutTombstone(localGame))
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
    return normalizeStore(JSON.parse(raw))
  } catch {
    return emptyStore()
  }
}

export function saveSyncStore(store, storage) {
  const normalized = normalizeStore(store)
  try {
    storageOrDefault(storage)?.setItem(KEY, JSON.stringify(normalized))
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
