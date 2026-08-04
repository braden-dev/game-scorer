import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudConfigured, supabase } from './supabase.js'
import { createCloudApi } from './cloudApi.js'
import { applyCloudSoftDelete, copyCloudMetadata, fromRemoteRows, hasCloudMetadata, mergeCloudCache, toRemoteRows } from './cloudState.js'
import {
  conservativeSyncCursor,
  activeGameIdForSync,
  clone,
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
const RETRY_STEADY_DELAY_MS = 30_000
export const CONFLICT_MESSAGE = 'Sync conflict; local changes kept. Retry when ready.'
const TERMINAL_CONFLICT_MESSAGE = 'Sync conflict; local changes kept. Please review the shared result.'
const CLOUD_METADATA = Symbol.for('gamescorer.cloudMetadata')

function createSyncRunner(operation) {
  let normalInFlight = null
  let initialInFlight = null

  const runNormal = () => {
    if (initialInFlight) return initialInFlight
    if (normalInFlight) return normalInFlight
    normalInFlight = Promise.resolve()
      .then(() => operation({ initial: false }))
      .finally(() => { normalInFlight = null })
    return normalInFlight
  }

  const runInitial = () => {
    if (initialInFlight) return initialInFlight
    const currentNormal = normalInFlight
    initialInFlight = (currentNormal
      ? currentNormal.then(() => operation({ initial: true }), () => operation({ initial: true }))
      : Promise.resolve().then(() => operation({ initial: true })))
      .finally(() => { initialInFlight = null })
    return initialInFlight
  }

  return (options = {}) => options.initial ? runInitial() : runNormal()
}

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

function isLocalStatePayload(payload) {
  return Array.isArray(payload?.roster)
    || (Array.isArray(payload?.games) && payload.games.some((game) => (
      game?.gameId !== undefined
      || Array.isArray(game?.players)
      || Array.isArray(game?.rounds)
    )))
}

function rowsForMutation(mutation) {
  const payload = mutation?.payload
  if (payload?.rows && typeof payload.rows === 'object') return payload.rows
  if (isLocalStatePayload(payload)) return toRemoteRows(payload)
  if (payload && REMOTE_KEYS.some((key) => Array.isArray(payload[key]))) return payload

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

function rebaseRemoteRow(row) {
  const version = new Date().toISOString()
  const rebased = { ...row, updated_at: version }
  if (row?.deleted_at != null) rebased.deleted_at = version
  return rebased
}

function rebaseLocalRow(row) {
  const version = new Date().toISOString()
  const rebased = { ...row, updatedAt: version }
  if (Object.prototype.hasOwnProperty.call(row ?? {}, 'updated_at')) rebased.updated_at = version
  if (row?.deletedAt != null || row?.deleted_at != null) {
    rebased.deletedAt = version
    if (Object.prototype.hasOwnProperty.call(row ?? {}, 'deleted_at')) rebased.deleted_at = version
  }
  return rebased
}

function rebaseLocalState(payload) {
  const nextPayload = { ...payload }
  if (Array.isArray(nextPayload.roster)) nextPayload.roster = nextPayload.roster.map(rebaseLocalRow)
  if (Array.isArray(nextPayload.games)) {
    nextPayload.games = nextPayload.games.map((game) => ({
      ...rebaseLocalRow(game),
      players: Array.isArray(game?.players) ? game.players.map(rebaseLocalRow) : game?.players,
      rounds: Array.isArray(game?.rounds) ? game.rounds.map(rebaseLocalRow) : game?.rounds,
    }))
  }
  return nextPayload
}

function rebaseRemoteRows(rows) {
  for (const key of REMOTE_KEYS) {
    if (Array.isArray(rows[key])) rows[key] = rows[key].map(rebaseRemoteRow)
  }
  return rows
}

function rebasePayload(payload, entity) {
  const nextPayload = clone(payload ?? {})
  if (!nextPayload || typeof nextPayload !== 'object' || Array.isArray(nextPayload)) return nextPayload
  if (nextPayload.rows && typeof nextPayload.rows === 'object' && !Array.isArray(nextPayload.rows)) {
    nextPayload.rows = rebaseRemoteRows(nextPayload.rows)
    return nextPayload
  }
  if (isLocalStatePayload(nextPayload)) return rebaseLocalState(nextPayload)
  if (REMOTE_KEYS.some((key) => Array.isArray(nextPayload[key]))) return rebaseRemoteRows(nextPayload)
  if (nextPayload.row && typeof nextPayload.row === 'object' && !Array.isArray(nextPayload.row)) {
    nextPayload.row = rebaseRemoteRow(nextPayload.row)
    return nextPayload
  }
  if (remoteKey(entity)) return rebaseRemoteRow(nextPayload)
  return nextPayload
}

function rebaseMutation(mutation) {
  const rebased = {
    ...mutation,
    payload: rebasePayload(mutation.payload, mutation.entity),
    conflictAttempts: Number(mutation.conflictAttempts ?? 0) + 1,
  }
  delete rebased.status
  delete rebased.error
  delete rebased.conflictedAt
  return rebased
}

function canRebaseMutation(mutation) {
  return mutation?.operation === 'upsert' && Number(mutation.conflictAttempts ?? 0) < 1
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
    const merged = mergeRemoteState(state, store.cache)
    return copyCloudMetadata({ ...merged, activeGameId: state?.activeGameId ?? null }, merged)
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

  const scheduleRetry = useCallback(() => {
    const hasReplayableWork = storeRef.current?.outbox.some(isReplayableMutation)
    if (!mountedRef.current || !online() || !hasReplayableWork || retryTimerRef.current) return

    const delay = retryAttemptsRef.current < MAX_AUTOMATIC_RETRIES
      ? Math.min(
        RETRY_BASE_DELAY_MS * (2 ** retryAttemptsRef.current),
        RETRY_MAX_DELAY_MS,
      )
      : RETRY_STEADY_DELAY_MS
    retryAttemptsRef.current += 1
    retryTimerRef.current = setTimeout(() => {
      retryTimerRef.current = null
      if (mountedRef.current) void syncNowRef.current?.()
    }, delay)
  }, [])

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
      return { ok: false, reason: 'error', fullSnapshot: initial }
    }
    if (!online()) {
      if (mountedRef.current) setStatus('offline')
      return { ok: false, reason: 'offline', fullSnapshot: initial }
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
    const existingConflict = store.outbox.find(isConflictMutation)
    let conflictMessage = existingConflict
      ? existingConflict.error ?? TERMINAL_CONFLICT_MESSAGE
      : (store.lastError === TERMINAL_CONFLICT_MESSAGE ? TERMINAL_CONFLICT_MESSAGE : CONFLICT_MESSAGE)
    const conflictDetected = Boolean(existingConflict)
      || store.outbox.some((mutation) => Number(mutation.conflictAttempts ?? 0) > 0)
      || store.lastError === CONFLICT_MESSAGE
      || store.lastError === TERMINAL_CONFLICT_MESSAGE
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
          const mergedConflictState = mergeRemoteState(
            latestStoreAfterConflict.cache,
            remoteState,
            previousSyncAt,
          )
          const refreshedCache = copyCloudMetadata({
            ...mergedConflictState,
            activeGameId: latestActiveGameId,
          }, mergedConflictState)
          const conflictedMutation = canRebaseMutation(mutation)
            ? rebaseMutation(mutation)
            : {
              ...mutation,
              status: 'conflict',
              error: TERMINAL_CONFLICT_MESSAGE,
              conflictedAt: new Date().toISOString(),
            }
          conflictMessage = canRebaseMutation(mutation) ? CONFLICT_MESSAGE : TERMINAL_CONFLICT_MESSAGE
          store = commitStore({
            ...latestStoreAfterConflict,
            outbox: latestStoreAfterConflict.outbox.map((queued) => (
              queued.id === mutation.id ? conflictedMutation : queued
            )),
            cache: refreshedCache,
            reconciledCache: copyCloudMetadata({ ...remoteState, activeGameId: latestActiveGameId }, remoteState),
            lastError: CONFLICT_MESSAGE,
          })
          stateRef.current = refreshedCache
          if (mountedRef.current) {
            setState(refreshedCache)
            setError(conflictMessage)
            setStatus(canRebaseMutation(mutation) ? 'error' : 'conflict')
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

      const terminalConflict = store.outbox.find(isConflictMutation)
      const rebasedMutationPending = store.outbox.some((mutation) => (
        isReplayableMutation(mutation) && Number(mutation.conflictAttempts ?? 0) > 0
      ))
      const finalConflictMessage = terminalConflict
        ? terminalConflict.error ?? TERMINAL_CONFLICT_MESSAGE
        : rebasedMutationPending ? CONFLICT_MESSAGE : null
      store = commitStore({ ...store, lastError: finalConflictMessage })
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
        setError(finalConflictMessage)
        setStatus(terminalConflict
          ? 'conflict'
          : finalConflictMessage ? 'error' : pendingAfterReplay ? 'pending' : 'synced')
      }
      const result = finalConflictMessage || pendingAfterReplay
        ? { ok: false, reason: 'error', fullSnapshot: initial }
        : { ok: true, fullSnapshot: initial }
      if (pendingAfterReplay) scheduleRetry()
      return result
    } catch (syncError) {
      const errorMessage = messageFor(syncError)
      store = commitStore({ ...(storeRef.current ?? store), lastError: errorMessage })
      if (mountedRef.current) {
        setError(errorMessage)
        setStatus(online() ? 'error' : 'offline')
      }
      scheduleRetry()
      return { ok: false, reason: 'error', fullSnapshot: initial }
    }
  }, [configured, publishStore, replayMutation, scheduleRetry, setState])

  const syncNow = useCallback((options) => {
    if (!syncRunnerRef.current) syncRunnerRef.current = createSyncRunner(runSync)
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
