const KEY = 'gamescorer.v1'

const EMPTY = { games: [], roster: [], activeGameId: null }

function getStorage(storage) {
  return storage ?? globalThis?.localStorage ?? globalThis?.window?.localStorage
}

export function loadState(storage = getStorage()) {
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

export function saveState(state, storage = getStorage()) {
  try {
    getStorage(storage)?.setItem(KEY, JSON.stringify(state))
  } catch (err) {
    console.warn('Could not save games to localStorage.', err)
  }
}
