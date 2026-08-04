const configuredBase = normalizeBasePath(
  (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL) || '/',
)

const ROUTE_SEGMENTS = new Set(['people', 'leaderboard', 'games', 'new-game', 'game-view'])
const listeners = new Set()
let listening = false

function normalizeBasePath(path) {
  if (!path || path === '/') return ''
  return `/${String(path).replace(/^\/+|\/+$/g, '')}`
}

function windowObject() {
  return typeof globalThis.window !== 'undefined' ? globalThis.window : null
}

function routePath(pathname) {
  const rawPath = String(pathname || '/').split(/[?#]/, 1)[0] || '/'
  const explicitPath = configuredBase && (rawPath === configuredBase || rawPath.startsWith(`${configuredBase}/`))
    ? rawPath.slice(configuredBase.length)
    : rawPath
  const parts = explicitPath.split('/').filter(Boolean)

  // In Node tests and when BUILD_BASE is not available at runtime, recognize
  // an arbitrary one-segment GitHub Pages repository prefix as well.
  if (parts.length > 1 && !ROUTE_SEGMENTS.has(parts[0]) && ROUTE_SEGMENTS.has(parts[1])) {
    parts.shift()
  }
  return parts
}

function decode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export function readRoute(pathname) {
  const win = windowObject()
  const source = pathname ?? win?.location?.pathname ?? '/'
  const parts = routePath(source)
  if (!parts.length) return { type: 'home' }

  if (parts[0] === 'people') {
    return parts.length === 2 && parts[1] ? { type: 'person', id: decode(parts[1]) } : parts.length === 1 ? { type: 'people' } : { type: 'home' }
  }
  if (parts[0] === 'leaderboard' && parts.length === 1) return { type: 'leaderboard' }
  if (parts[0] === 'games') {
    return parts.length === 2 && parts[1] ? { type: 'game', id: decode(parts[1]) } : parts.length === 1 ? { type: 'games' } : { type: 'home' }
  }
  if (parts[0] === 'new-game') {
    return parts.length === 2 && parts[1] ? { type: 'new-game', gameId: decode(parts[1]) } : { type: 'home' }
  }
  if (parts[0] === 'game-view') {
    return parts.length === 2 && parts[1] ? { type: 'game', id: decode(parts[1]) } : { type: 'home' }
  }
  return { type: 'home' }
}

function pathForRoute(route) {
  if (typeof route === 'string') return route.startsWith('/') ? route : `/${route}`
  const type = route?.type ?? route?.page ?? route?.name
  if (type === 'people') return '/people'
  if (type === 'person') return `/people/${encodeURIComponent(route.id)}`
  if (type === 'leaderboard') return '/leaderboard'
  if (type === 'games') return '/games'
  if (type === 'game' || type === 'game-view') return `/games/${encodeURIComponent(route.id ?? route.gameId)}`
  if (type === 'new-game') return `/new-game/${encodeURIComponent(route.gameId ?? route.id)}`
  return '/'
}

export function navigate(route) {
  const win = windowObject()
  const path = pathForRoute(route)
  if (!win?.history?.pushState) return path
  const nextPath = configuredBase && !(path === configuredBase || path.startsWith(`${configuredBase}/`))
    ? `${configuredBase}${path === '/' ? '/' : path}`
    : path
  win.history.pushState({}, '', nextPath)
  if (typeof win.dispatchEvent === 'function') {
    const event = typeof win.PopStateEvent === 'function'
      ? new win.PopStateEvent('popstate')
      : typeof globalThis.PopStateEvent === 'function'
        ? new globalThis.PopStateEvent('popstate')
        : { type: 'popstate' }
    win.dispatchEvent(event)
  }
  return path
}

export function subscribeToRoutes(listener) {
  if (typeof listener !== 'function') return () => {}
  listeners.add(listener)
  const win = windowObject()
  if (!listening && typeof win?.addEventListener === 'function') {
    win.addEventListener('popstate', notify)
    listening = true
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size && listening && typeof win?.removeEventListener === 'function') {
      win.removeEventListener('popstate', notify)
      listening = false
    }
  }
}

function notify() {
  const route = readRoute()
  for (const listener of listeners) listener(route)
}
