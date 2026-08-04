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

function applyPendingSoftDeletes(cache, outbox) {
  return (outbox ?? []).filter(isSoftDeleteMutation).reduce(
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

function mergeMutationResponse(cache, mutation, response) {
  const rows = responseRowsForMutation(mutation, response)
  if (!rows) return cache
  const activeGameId = cache?.activeGameId ?? null
  const remoteState = fromRemoteRows(rows, activeGameId)
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
    setPendingCount(store.outbox.length)
  }, [])

  const commitStore = useCallback((nextStore, removedMutationIds = []) => {
    const latestStore = storeRef.current ?? nextStore
    const committed = mergeSyncStore(latestStore, nextStore, removedMutationIds)
    publishStore(committed)
    saveSyncStore(committed)
    return committed
  }, [publishStore])

  const updateSyncStore = useCallback((update) => {
    const current = storeRef.current ?? loadSyncStore()
    const next = typeof update === 'function' ? update(current) : { ...current, ...update }
    return commitStore(next)
  }, [commitStore])

  const replayMutation = useCallback(async (mutation) => {
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
    if (store.outbox.some(isSoftDeleteMutation)) {
      stateRef.current = baseCache
      if (mountedRef.current) setState(baseCache)
    }
    if (mountedRef.current) {
      setStatus('syncing')
      setError(null)
    }

    try {
      const rows = initial || !store.lastSyncAt
        ? await apiRef.current.fetchSnapshot()
        : await apiRef.current.fetchRowsUpdatedSince(store.lastSyncAt)
      const latestStore = storeRef.current ?? store
      const latestActiveGameId = activeGameIdForSync(stateRef, latestStore)
      const latestCache = applyPendingSoftDeletes({ ...latestStore.cache, activeGameId: latestActiveGameId }, latestStore.outbox)
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
        const response = await replayMutation(mutation)
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
        const responseReconciledCache = mergeMutationResponse(latestReconciledCache, mutation, response)
        store = commitStore({
          ...removeMutation(latestStoreAfterReplay, mutation.id),
          cache: responseCache,
          reconciledCache: responseReconciledCache,
        }, [mutation.id])
        stateRef.current = responseCache
        if (mountedRef.current && response) setState(responseCache)
      }

      store = commitStore({ ...store, lastError: null })
      const pendingDeleteCache = applyPendingSoftDeletes(store.cache, store.outbox)
      const pendingDeleteChanged = pendingDeleteCache !== store.cache
      if (pendingDeleteChanged) store = commitStore({ ...store, cache: pendingDeleteCache })
      if (replayedSoftDelete || pendingDeleteChanged) {
        stateRef.current = store.cache
        if (mountedRef.current) setState(store.cache)
      }
      const pendingAfterReplay = store.outbox.length > 0
      clearRetry()
      if (mountedRef.current) setStatus(pendingAfterReplay ? 'pending' : 'synced')
      if (pendingAfterReplay) {
        setTimeout(() => {
          if (mountedRef.current && storeRef.current?.outbox.length) void syncNow()
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

  return { status, pendingCount, error, syncNow, enqueueStateMutation, updateSyncStore }
}
