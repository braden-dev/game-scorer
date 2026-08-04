import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudConfigured, supabase } from './supabase.js'
import { createCloudApi } from './cloudApi.js'
import { applyCloudSoftDelete, copyCloudMetadata, fromRemoteRows, hasCloudMetadata, mergeCloudCache, toRemoteRows } from './cloudState.js'
import {
  conservativeSyncCursor,
  activeGameIdForSync,
  createInFlightSync,
  enqueueMutation,
  loadSyncStore,
  mergeSyncStore,
  mergeRemoteState,
  registerSyncListeners,
  removeMutation,
  saveSyncStore,
} from './sync.js'
import { uid } from './util.js'

const REMOTE_KEYS = ['people', 'games', 'gamePlayers', 'rounds']
const RETRY_BASE_DELAY_MS = 50
const RETRY_MAX_DELAY_MS = 1000
const MAX_AUTOMATIC_RETRIES = 5
export const CONFLICT_MESSAGE = 'This was changed on another device. The shared version is now shown.'
const CLOUD_METADATA = Symbol.for('gamescorer.cloudMetadata')

function online() {
  return globalThis.navigator?.onLine !== false
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error)
}

function isoTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

function hasCachedState(store) {
  return store.cache.games.length > 0 || store.cache.roster.length > 0 || hasCloudMetadata(store.cache)
}

function cacheForState(state, metadataSource = state) {
  return mergeCloudCache(metadataSource, state)
}

function remoteKey(entity) {
  if (entity === 'game_players' || entity === 'gamePlayers') return 'gamePlayers'
  if (REMOTE_KEYS.includes(entity)) return entity
  return null
}

function rowsForMutation(mutation) {
  const payload = mutation?.payload
  if (payload?.rows && typeof payload.rows === 'object') return payload.rows
  if (payload && REMOTE_KEYS.some((key) => Array.isArray(payload[key]))) return payload
  if (payload?.games || payload?.roster) return toRemoteRows(payload)

  const key = remoteKey(mutation?.entity)
  if (!key) return null
  return Object.fromEntries(REMOTE_KEYS.map((remoteRowKey) => [
    remoteRowKey,
    remoteRowKey === key ? [payload?.row ?? payload] : [],
  ]))
}

function isCasConflict(error) {
  const message = messageFor(error)
  return /stale mutation|conflicting equal-version row/i.test(message)
}

function removeConflictRows(cache, mutation) {
  const rows = rowsForMutation(mutation) ?? {}
  const gameIds = new Set((rows.games ?? []).map((row) => row?.id).filter(Boolean))
  const personIds = new Set((rows.people ?? []).map((row) => row?.id).filter(Boolean))
  const roundIds = new Set((rows.rounds ?? []).map((row) => `${row?.game_id}\u0000${row?.id}`))
  const playerIds = new Set((rows.gamePlayers ?? []).map((row) => `${row?.game_id}\u0000${row?.person_id}`))

  if (mutation?.entity === 'games') gameIds.add(mutation.entityId)
  if (mutation?.entity === 'people') personIds.add(mutation.entityId)
  if (mutation?.entity === 'rounds') {
    const gameId = mutation.payload?.gameId ?? mutation.payload?.game_id
    if (gameId != null) roundIds.add(`${gameId}\u0000${mutation.entityId}`)
  }
  if (mutation?.entity === 'game_players' || mutation?.entity === 'gamePlayers') {
    const gameId = mutation.entityId?.gameId ?? mutation.entityId?.game_id
    const personId = mutation.entityId?.personId ?? mutation.entityId?.person_id
    if (gameId != null && personId != null) playerIds.add(`${gameId}\u0000${personId}`)
  }

  const next = {
    ...cache,
    roster: (cache?.roster ?? []).filter((person) => !personIds.has(person.id)),
    games: (cache?.games ?? [])
      .filter((game) => !gameIds.has(game.id))
      .map((game) => ({
        ...game,
        players: (game.players ?? []).filter((player) => !playerIds.has(`${game.id}\u0000${player.id}`)),
        rounds: (game.rounds ?? []).filter((round) => !roundIds.has(`${game.id}\u0000${round.id}`)),
      })),
  }
  const metadata = cache?.[CLOUD_METADATA]
  if (metadata) {
    Object.defineProperty(next, CLOUD_METADATA, {
      configurable: true,
      value: {
        ...metadata,
        roster: (metadata.roster ?? []).filter((person) => !personIds.has(person.id)),
        games: (metadata.games ?? []).filter((game) => !gameIds.has(game.id)),
        gamePlayers: (metadata.gamePlayers ?? []).filter((player) => !playerIds.has(`${player.gameId}\u0000${player.id}`)),
        rounds: (metadata.rounds ?? []).filter((round) => !roundIds.has(`${round.gameId}\u0000${round.id}`)),
      },
    })
  }
  return next
}

function mutationUpdatedAt(mutation) {
  const value = mutation?.updatedAt
    ?? mutation?.payload?.updatedAt
    ?? mutation?.payload?.updated_at
    ?? mutation?.createdAt
  return isoTimestamp(value)
}

function isSoftDeleteMutation(mutation) {
  return mutation?.operation === 'softDelete' || mutation?.operation === 'delete'
}

function isRestoreMutation(mutation) {
  return mutation?.operation === 'restore'
}

function isConflictMutation(mutation) {
  return mutation?.status === 'conflict'
}

function isReplayableMutation(mutation) {
  return !isConflictMutation(mutation)
}

function applyPendingSoftDeletes(cache, outbox) {
  return (outbox ?? []).filter((mutation) => isReplayableMutation(mutation) && isSoftDeleteMutation(mutation)).reduce(
    (nextCache, mutation) => applyCloudSoftDelete(
      nextCache,
      mutation.entity,
      mutation.entityId,
      mutationUpdatedAt(mutation),
      mutation.payload,
    ),
    cache,
  )
}

function responseRowsForMutation(mutation, response) {
  if (!response || typeof response !== 'object') return null
  if (REMOTE_KEYS.some((key) => Array.isArray(response[key]))) return response
  const key = remoteKey(mutation?.entity)
  if (!isSoftDeleteMutation(mutation) || !key) return null
  return Object.fromEntries(REMOTE_KEYS.map((remoteRowKey) => [
    remoteRowKey,
    remoteRowKey === key ? [response] : [],
  ]))
}

function responseWithParentContext(cache, rows, fallbackCache = cache) {
  if (rows.games?.length || (!rows.rounds?.length && !rows.gamePlayers?.length)) return rows
  const gameIds = new Set([
    ...(rows.rounds ?? []).map((round) => round?.game_id ?? round?.gameId),
    ...(rows.gamePlayers ?? []).map((player) => player?.game_id ?? player?.gameId),
  ].filter(Boolean))
  if (!gameIds.size) return rows

  const currentGames = new Map((cache?.games ?? []).map((game) => [game.id, game]))
  const fallbackGames = new Map((fallbackCache?.games ?? []).map((game) => [game.id, game]))
  const parentGames = [...gameIds]
    .map((gameId) => currentGames.get(gameId) ?? fallbackGames.get(gameId))
    .filter(Boolean)
  if (!parentGames.length) return rows

  return {
    ...rows,
    games: toRemoteRows({ ...(fallbackCache ?? cache), games: parentGames, roster: [] }).games,
  }
}

function mergeMutationResponse(cache, mutation, response, fallbackCache = cache) {
  const rows = responseRowsForMutation(mutation, response)
  if (!rows) return cache
  const activeGameId = cache?.activeGameId ?? null
  const remoteState = fromRemoteRows(responseWithParentContext(cache, rows, fallbackCache), activeGameId)
  const merged = mergeRemoteState(cache, remoteState)
  return copyCloudMetadata({ ...merged, activeGameId }, merged)
}

function initialCache(store, state) {
  if (hasCachedState(store)) {
    return copyCloudMetadata({ ...store.cache, activeGameId: state?.activeGameId ?? null }, store.cache)
  }
  return cacheForState(state)
}

export function useCloudSync(currentState, setState, dependencies = {}) {
  const configured = dependencies.configured ?? cloudConfigured()
  const [status, setStatus] = useState(configured ? 'syncing' : 'local')
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState(null)
  const stateRef = useRef(currentState)
  const storeRef = useRef(null)
  const mountedRef = useRef(false)
  const syncRunnerRef = useRef(null)
  const syncNowRef = useRef(null)
  const retryTimerRef = useRef(null)
  const retryAttemptsRef = useRef(0)
  const apiRef = useRef(dependencies.api ?? (configured ? createCloudApi(supabase) : null))

  const clearRetry = () => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    retryTimerRef.current = null
    retryAttemptsRef.current = 0
  }

  useEffect(() => {
    stateRef.current = currentState
  }, [currentState])

  const publishStore = useCallback((store) => {
    storeRef.current = store
    setPendingCount(store.outbox.filter(isReplayableMutation).length)
  }, [])

  const commitStore = useCallback((nextStore, removedMutationIds = []) => {
    const latestStore = storeRef.current ?? nextStore
    const committed = mergeSyncStore(latestStore, nextStore, removedMutationIds)
    publishStore(committed)
    saveSyncStore(committed)
    return committed
  }, [publishStore])

  const updateSyncStore = useCallback((update, removedMutationIds = []) => {
    const current = storeRef.current ?? loadSyncStore()
    const next = typeof update === 'function' ? update(current) : { ...current, ...update }
    return commitStore(next, removedMutationIds)
  }, [commitStore])

  const cancelSyncMutations = useCallback((predicate) => {
    const current = storeRef.current ?? loadSyncStore()
    const removedMutationIds = current.outbox
      .filter((mutation) => predicate?.(mutation))
      .map((mutation) => mutation.id)
    return updateSyncStore({
      ...current,
      outbox: current.outbox.filter((mutation) => !removedMutationIds.includes(mutation.id)),
    }, removedMutationIds)
  }, [updateSyncStore])

  const replayMutation = useCallback(async (mutation) => {
    if (isRestoreMutation(mutation)) {
      const rows = rowsForMutation(mutation)
      if (!rows) throw new Error(`Cannot build rows for restore entity: ${mutation?.entity}`)
      if (typeof apiRef.current.restoreRows !== 'function') {
        throw new Error('Cloud restore is unavailable')
      }
      return apiRef.current.restoreRows(rows, mutation.restore ?? mutation.payload?.restore ?? {})
    }
    if (isSoftDeleteMutation(mutation)) {
      return apiRef.current.softDelete(mutation.entity, mutation.entityId, mutationUpdatedAt(mutation))
    }

    if (mutation?.operation !== 'upsert') throw new Error(`Unknown sync operation: ${mutation?.operation}`)
    const rows = rowsForMutation(mutation)
    if (!rows) throw new Error(`Cannot build rows for sync entity: ${mutation?.entity}`)
    return apiRef.current.upsertRows(rows)
  }, [])

  const runSync = useCallback(async ({ initial = false } = {}) => {
    if (!configured || !apiRef.current) {
      if (mountedRef.current) setStatus('local')
      return
    }
    if (!online()) {
      if (mountedRef.current) setStatus('offline')
      return
    }

    let store = storeRef.current ?? loadSyncStore()
    const syncStartedAt = new Date().toISOString()
    const syncCursor = conservativeSyncCursor(store.lastSyncAt, syncStartedAt)
    const previousSyncAt = store.lastSyncAt
    const activeGameId = activeGameIdForSync(stateRef, store)
    const baseCache = applyPendingSoftDeletes(copyCloudMetadata(
      copyCloudMetadata({ ...cacheForState(stateRef.current), ...store.cache, activeGameId }, store.cache),
      stateRef.current,
    ), store.outbox)
    store = commitStore({ ...store, cache: baseCache })
    let conflictDetected = store.outbox.some(isConflictMutation) || store.lastError === CONFLICT_MESSAGE
    if (store.outbox.some((mutation) => isReplayableMutation(mutation) && isSoftDeleteMutation(mutation))) {
      stateRef.current = baseCache
      if (mountedRef.current) setState(baseCache)
    }
    if (mountedRef.current) {
      setStatus('syncing')
      setError(conflictDetected ? CONFLICT_MESSAGE : null)
    }

    try {
      const rows = initial || !store.lastSyncAt
        ? await apiRef.current.fetchSnapshot()
        : await apiRef.current.fetchRowsUpdatedSince(store.lastSyncAt)
      const latestStore = storeRef.current ?? store
      const latestActiveGameId = activeGameIdForSync(stateRef, latestStore)
      const latestCache = applyPendingSoftDeletes(
        copyCloudMetadata({ ...latestStore.cache, activeGameId: latestActiveGameId }, latestStore.cache),
        latestStore.outbox,
      )
      const remoteState = fromRemoteRows(rows, latestActiveGameId)
      const mergedState = mergeRemoteState(latestCache, remoteState, previousSyncAt)
      const reconciledState = initial || !latestStore.lastSyncAt
        ? remoteState
        : mergeRemoteState(latestStore.reconciledCache, remoteState, previousSyncAt)
      const mergedCache = copyCloudMetadata({
        ...mergedState,
        activeGameId: latestActiveGameId,
      }, mergedState)
      const reconciledCache = copyCloudMetadata({
        ...reconciledState,
        activeGameId: latestActiveGameId,
      }, reconciledState)
      store = commitStore({
        ...latestStore,
        cache: mergedCache,
        reconciledCache,
        lastSyncAt: syncCursor,
        lastError: null,
      })
      stateRef.current = mergedCache
      if (mountedRef.current) setState(mergedCache)

      let replayedSoftDelete = false
      for (const mutation of [...store.outbox]) {
        const queuedMutation = (storeRef.current?.outbox ?? store.outbox).find((queued) => queued.id === mutation.id)
        if (!queuedMutation || isConflictMutation(queuedMutation)) continue
        let response
        try {
          response = await replayMutation(mutation)
        } catch (replayError) {
          if (!isCasConflict(replayError)) throw replayError

          const refreshedRows = await apiRef.current.fetchSnapshot()
          const latestStoreAfterConflict = storeRef.current ?? store
          const latestActiveGameId = activeGameIdForSync(stateRef, latestStoreAfterConflict)
          const remoteState = fromRemoteRows(refreshedRows, latestActiveGameId)
          const localWithoutConflict = removeConflictRows(latestStoreAfterConflict.cache, mutation)
          const refreshedCache = copyCloudMetadata({
            ...mergeRemoteState(localWithoutConflict, remoteState, previousSyncAt),
            activeGameId: latestActiveGameId,
          }, remoteState)
          const conflictedMutation = {
            ...mutation,
            status: 'conflict',
            error: CONFLICT_MESSAGE,
            conflictedAt: new Date().toISOString(),
          }
          store = commitStore({
            ...latestStoreAfterConflict,
            outbox: latestStoreAfterConflict.outbox.map((queued) => (
              queued.id === mutation.id ? conflictedMutation : queued
            )),
            cache: refreshedCache,
            reconciledCache: copyCloudMetadata({ ...remoteState, activeGameId: latestActiveGameId }, remoteState),
            lastError: CONFLICT_MESSAGE,
          })
          conflictDetected = true
          stateRef.current = refreshedCache
          if (mountedRef.current) {
            setState(refreshedCache)
            setError(CONFLICT_MESSAGE)
            setStatus('error')
          }
          clearRetry()
          continue
        }
        replayedSoftDelete ||= isSoftDeleteMutation(mutation)
        const latestStoreAfterReplay = storeRef.current ?? store
        const latestActiveGameId = activeGameIdForSync(stateRef, latestStoreAfterReplay)
        const latestCacheForReplay = copyCloudMetadata({
          ...latestStoreAfterReplay.cache,
          activeGameId: latestActiveGameId,
        }, latestStoreAfterReplay.cache)
        const latestReconciledCache = copyCloudMetadata({
          ...latestStoreAfterReplay.reconciledCache,
          activeGameId: latestActiveGameId,
        }, latestStoreAfterReplay.reconciledCache)
        const responseCache = mergeMutationResponse(latestCacheForReplay, mutation, response)
        const responseReconciledCache = mergeMutationResponse(
          latestReconciledCache,
          mutation,
          response,
          latestCacheForReplay,
        )
        store = commitStore({
          ...removeMutation(latestStoreAfterReplay, mutation.id),
          cache: responseCache,
          reconciledCache: responseReconciledCache,
        }, [mutation.id])
        stateRef.current = responseCache
        if (mountedRef.current && response) setState(responseCache)
      }

      store = commitStore({ ...store, lastError: conflictDetected ? CONFLICT_MESSAGE : null })
      const pendingDeleteCache = applyPendingSoftDeletes(store.cache, store.outbox)
      const pendingDeleteChanged = pendingDeleteCache !== store.cache
      if (pendingDeleteChanged) store = commitStore({ ...store, cache: pendingDeleteCache })
      if (replayedSoftDelete || pendingDeleteChanged) {
        stateRef.current = store.cache
        if (mountedRef.current) setState(store.cache)
      }
      const pendingAfterReplay = store.outbox.some(isReplayableMutation)
      clearRetry()
      if (mountedRef.current) {
        setError(conflictDetected ? CONFLICT_MESSAGE : null)
        setStatus(conflictDetected ? 'error' : pendingAfterReplay ? 'pending' : 'synced')
      }
      if (pendingAfterReplay) {
        setTimeout(() => {
          if (mountedRef.current && storeRef.current?.outbox.some(isReplayableMutation)) void syncNow()
        }, 0)
      }
    } catch (syncError) {
      const errorMessage = messageFor(syncError)
      store = commitStore({ ...(storeRef.current ?? store), lastError: errorMessage })
      if (mountedRef.current) {
        setError(errorMessage)
        setStatus(online() ? 'error' : 'offline')
      }
      if (online() && mountedRef.current && !retryTimerRef.current
        && retryAttemptsRef.current < MAX_AUTOMATIC_RETRIES) {
        const delay = Math.min(
          RETRY_BASE_DELAY_MS * (2 ** retryAttemptsRef.current),
          RETRY_MAX_DELAY_MS,
        )
        retryAttemptsRef.current += 1
        retryTimerRef.current = setTimeout(() => {
          retryTimerRef.current = null
          if (mountedRef.current) void syncNowRef.current?.()
        }, delay)
      }
    }
  }, [configured, publishStore, replayMutation, setState])

  const syncNow = useCallback((options) => {
    if (!syncRunnerRef.current) syncRunnerRef.current = createInFlightSync(runSync)
    return syncRunnerRef.current(options)
  }, [runSync])
  syncNowRef.current = syncNow

  const enqueueStateMutation = useCallback((mutation) => {
    if (!configured || !mutation) return null
    const store = storeRef.current ?? loadSyncStore()
    const { state: mutationState, ...mutationDetails } = mutation
    const nextMutation = {
      id: mutation.id ?? uid('m'),
      createdAt: mutation.createdAt ?? Date.now(),
      ...mutationDetails,
    }
    const nextCache = cacheForState(mutationState ?? stateRef.current, store.cache)
    const next = enqueueMutation({
      ...store,
      cache: nextCache,
    }, nextMutation)
    if (mutationState) stateRef.current = nextCache
    commitStore(next)
    if (isSoftDeleteMutation(nextMutation)) {
      stateRef.current = next.cache
      if (mountedRef.current) setState(next.cache)
    }
    if (mountedRef.current) setStatus('pending')
    if (online()) void syncNow()
    return next
  }, [commitStore, configured, syncNow])

  useEffect(() => {
    mountedRef.current = true
    if (!configured) return () => {
      mountedRef.current = false
      clearRetry()
    }

    const store = loadSyncStore()
    const cache = initialCache(store, stateRef.current)
    const hydratedStore = { ...store, cache }
    stateRef.current = cache
    publishStore(hydratedStore)
    saveSyncStore(hydratedStore)
    setState(cache)
    if (online()) void syncNow({ initial: true })
    else setStatus('offline')

    const refresh = () => {
      if (online()) void syncNow()
      else setStatus('offline')
    }
    const onVisibilityChange = () => {
      if (globalThis.document?.visibilityState === 'visible') refresh()
    }
    const removeListeners = registerSyncListeners({
      target: globalThis,
      document: globalThis.document,
      onOnline: refresh,
      onVisibility: onVisibilityChange,
    })

    return () => {
      mountedRef.current = false
      removeListeners()
      clearRetry()
    }
  }, [configured, publishStore, setState, syncNow])

  return { status, pendingCount, error, syncNow, enqueueStateMutation, updateSyncStore, cancelSyncMutations }
}
