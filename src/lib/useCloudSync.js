import { useCallback, useEffect, useRef, useState } from 'react'
import { cloudConfigured, supabase } from './supabase.js'
import { createCloudApi } from './cloudApi.js'
import { copyCloudMetadata, fromRemoteRows, hasCloudMetadata, toRemoteRows } from './cloudState.js'
import {
  conservativeSyncCursor,
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

function cacheForState(state) {
  return copyCloudMetadata({
    ...(state ?? { games: [], roster: [] }),
    games: Array.isArray(state?.games) ? state.games : [],
    roster: Array.isArray(state?.roster) ? state.roster : [],
    activeGameId: state?.activeGameId ?? null,
  }, state)
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

function initialCache(store, state) {
  if (hasCachedState(store)) {
    return copyCloudMetadata({ ...store.cache, activeGameId: state?.activeGameId ?? null }, store.cache)
  }
  return cacheForState(state)
}

export function useCloudSync(currentState, setState) {
  const configured = cloudConfigured()
  const [status, setStatus] = useState(configured ? 'syncing' : 'local')
  const [pendingCount, setPendingCount] = useState(0)
  const [error, setError] = useState(null)
  const stateRef = useRef(currentState)
  const storeRef = useRef(null)
  const mountedRef = useRef(false)
  const syncRunnerRef = useRef(null)
  const apiRef = useRef(configured ? createCloudApi(supabase) : null)

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

  const replayMutation = useCallback(async (mutation) => {
    if (mutation?.operation === 'softDelete' || mutation?.operation === 'delete') {
      await apiRef.current.softDelete(mutation.entity, mutation.entityId, mutationUpdatedAt(mutation))
      return
    }

    if (mutation?.operation !== 'upsert') throw new Error(`Unknown sync operation: ${mutation?.operation}`)
    const rows = rowsForMutation(mutation)
    if (!rows) throw new Error(`Cannot build rows for sync entity: ${mutation?.entity}`)
    await apiRef.current.upsertRows(rows)
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
    const activeGameId = stateRef.current?.activeGameId ?? null
    const baseCache = copyCloudMetadata(
      copyCloudMetadata({ ...cacheForState(stateRef.current), ...store.cache, activeGameId }, store.cache),
      stateRef.current,
    )
    store = { ...store, cache: baseCache }
    publishStore(store)
    if (mountedRef.current) {
      setStatus('syncing')
      setError(null)
    }

    try {
      const rows = initial || !store.lastSyncAt
        ? await apiRef.current.fetchSnapshot()
        : await apiRef.current.fetchRowsUpdatedSince(store.lastSyncAt)
      const remoteState = fromRemoteRows(rows, activeGameId)
      const latestStore = storeRef.current ?? store
      const mergedState = mergeRemoteState(latestStore.cache, remoteState, previousSyncAt)
      const mergedCache = copyCloudMetadata({
        ...mergedState,
        activeGameId,
      }, mergedState)
      store = commitStore({
        ...latestStore,
        cache: mergedCache,
        lastSyncAt: syncCursor,
        lastError: null,
      })
      stateRef.current = mergedCache
      if (mountedRef.current) setState(mergedCache)

      for (const mutation of [...store.outbox]) {
        await replayMutation(mutation)
        const latestStoreAfterReplay = storeRef.current ?? store
        store = commitStore(removeMutation(latestStoreAfterReplay, mutation.id), [mutation.id])
      }

      store = commitStore({ ...store, lastError: null })
      if (mountedRef.current) setStatus(store.outbox.length ? 'pending' : 'synced')
    } catch (syncError) {
      const errorMessage = messageFor(syncError)
      store = commitStore({ ...(storeRef.current ?? store), lastError: errorMessage })
      if (mountedRef.current) {
        setError(errorMessage)
        setStatus(online() ? 'error' : 'offline')
      }
    }
  }, [configured, publishStore, replayMutation, setState])

  const syncNow = useCallback((options) => {
    if (!syncRunnerRef.current) syncRunnerRef.current = createInFlightSync(runSync)
    return syncRunnerRef.current(options)
  }, [runSync])

  const enqueueStateMutation = useCallback((mutation) => {
    if (!configured || !mutation) return null
    const store = storeRef.current ?? loadSyncStore()
    const next = enqueueMutation({
      ...store,
      cache: cacheForState(stateRef.current),
    }, {
      id: mutation.id ?? uid('m'),
      createdAt: mutation.createdAt ?? Date.now(),
      ...mutation,
    })
    commitStore(next)
    if (mountedRef.current) setStatus('pending')
    if (online()) void syncNow()
    return next
  }, [commitStore, configured, syncNow])

  useEffect(() => {
    mountedRef.current = true
    if (!configured) return () => { mountedRef.current = false }

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
    }
  }, [configured, publishStore, setState, syncNow])

  return { status, pendingCount, error, syncNow, enqueueStateMutation }
}
