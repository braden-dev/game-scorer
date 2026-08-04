const KEY = 'gamescorer.cloud.v1'

const EMPTY_CACHE = { games: [], roster: [], activeGameId: null }
const EMPTY_STORE = {
  cache: EMPTY_CACHE,
  outbox: [],
  lastSyncAt: null,
  lastError: null,
  initialMigrationCompleted: false,
}

function storageOrDefault(storage) {
  if (storage) return storage
  return globalThis?.localStorage ?? globalThis?.window?.localStorage ?? null
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]))
  }
  return value
}

function normalizeCache(cache) {
  return {
    ...(cache && typeof cache === 'object' ? clone(cache) : {}),
    games: Array.isArray(cache?.games) ? clone(cache.games) : [],
    roster: Array.isArray(cache?.roster) ? clone(cache.roster) : [],
    activeGameId: cache?.activeGameId ?? null,
  }
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
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!text) return null
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text)
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  const milliseconds = Date.parse(text)
  return Number.isFinite(milliseconds) ? milliseconds : null
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

function mergeRecords(localRecords, remoteRecords, remoteFallback = 0) {
  const local = Array.isArray(localRecords) ? localRecords : []
  const remote = Array.isArray(remoteRecords) ? remoteRecords : []
  const localById = new Map(local.filter((record) => record?.id != null).map((record) => [record.id, record]))
  const remoteById = new Map(remote.filter((record) => record?.id != null).map((record) => [record.id, record]))
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
      chosen = version(remoteRecord, remoteFallback) >= version(localRecord) ? remoteRecord : localRecord
      if (isTombstone(chosen)) continue
    }

    merged.push(withoutTombstone(chosen))
  }

  return merged
}

function mergeGame(localGame, remoteGame, lastSyncAt) {
  const remoteFallback = timestamp(recordField(remoteGame, 'updatedAt', 'updated_at')) ?? lastSyncAt ?? 0
  const game = version(remoteGame, remoteFallback) >= version(localGame)
    ? remoteGame
    : localGame
  if (isTombstone(game)) return null

  const merged = withoutTombstone(game)
  merged.players = mergeRecords(localGame?.players, remoteGame?.players, remoteFallback)
  merged.rounds = mergeRecords(localGame?.rounds, remoteGame?.rounds, remoteFallback)
  return merged
}

function mergeGames(localGames, remoteGames, lastSyncAt) {
  const local = Array.isArray(localGames) ? localGames : []
  const remote = Array.isArray(remoteGames) ? remoteGames : []
  const localById = new Map(local.filter((game) => game?.id != null).map((game) => [game.id, game]))
  const remoteById = new Map(remote.filter((game) => game?.id != null).map((game) => [game.id, game]))
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

    const game = mergeGame(localGame, remoteGame, lastSyncAt)
    if (game) merged.push(game)
  }

  return merged
}

export function loadSyncStore(storage = storageOrDefault()) {
  try {
    const raw = storageOrDefault(storage)?.getItem(KEY)
    if (!raw) return emptyStore()
    return normalizeStore(JSON.parse(raw))
  } catch {
    return emptyStore()
  }
}

export function saveSyncStore(store, storage = storageOrDefault()) {
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

  return {
    ...local,
    roster: mergeRecords(local.roster, remote.roster, syncFallback),
    games: mergeGames(local.games, remote.games, syncFallback),
    activeGameId: local.activeGameId,
  }
}
