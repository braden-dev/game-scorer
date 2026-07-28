export function uid(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

/** Parse a possibly-empty text field into a number, falling back to 0. */
export function num(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

export function formatSigned(n) {
  return n > 0 ? `+${n}` : `${n}`
}

export function relativeDate(ts) {
  const diff = Date.now() - ts
  const mins = Math.round(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Deterministic color for a player chip, derived from their id. */
const PLAYER_COLORS = [
  '#f97316', '#38bdf8', '#a78bfa', '#34d399',
  '#f472b6', '#facc15', '#fb7185', '#22d3ee',
  '#c084fc', '#4ade80', '#fbbf24', '#60a5fa',
]

export function playerColor(index) {
  return PLAYER_COLORS[index % PLAYER_COLORS.length]
}

export function initials(name) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
