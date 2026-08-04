import { mergeCloudCache } from './cloudState.js'
import { loadSyncStore, saveSyncStore } from './sync.js'

const KEY = 'gamescorer.v1'

const EMPTY = { games: [], roster: [], activeGameId: null }

function getStorage(storage) {
  if (storage !== undefined) return storage
  try {
    return globalThis?.localStorage ?? globalThis?.window?.localStorage
  } catch {
    return null
  }
}

export function loadState(storage) {
  try {
    const raw = getStorage(storage)?.getItem(KEY)
    if (!raw) return { ...EMPTY }
    const parsed = JSON.parse(raw)
    return {
      games: Array.isArray(parsed.games) ? parsed.games : [],
      roster: Array.isArray(parsed.roster) ? parsed.roster : [],
      activeGameId: parsed.activeGameId ?? null,
    }
  } catch (err) {
    console.warn('Could not read saved games, starting fresh.', err)
    return { ...EMPTY }
  }
}

export function saveState(state, storage) {
  try {
    getStorage(storage)?.setItem(KEY, JSON.stringify(state))
  } catch (err) {
    console.warn('Could not save games to localStorage.', err)
  }
}

/**
 * Keep the cloud cache in the same nested shape the app renders. The active
 * game is intentionally retained here for device-local navigation; only
 * toRemoteRows() crosses the cloud boundary and omits it.
 */
export function saveStateToCloudCache(state, storage) {
  const store = loadSyncStore(storage)
  const nextStore = {
    ...store,
    cache: mergeCloudCache(store.cache, state),
  }
  saveSyncStore(nextStore, storage)
  return nextStore
}

export function hasStateData(state) {
  return Boolean(state?.games?.length || state?.roster?.length)
}

export function shouldOfferInitialMigration({ configured, hadLocalDataAtStartup, initialMigrationCompleted }) {
  return Boolean(configured && hadLocalDataAtStartup && !initialMigrationCompleted)
}

export function loadReconciledState(storage) {
  const store = loadSyncStore(storage)
  return store.lastSyncAt && store.reconciledCache ? store.reconciledCache : null
}
