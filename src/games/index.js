import farkle from './farkle.jsx'
import dutchBlitz from './dutchBlitz.jsx'
import threeThirteen from './threeThirteen.jsx'

export const GAMES = [farkle, dutchBlitz, threeThirteen]

export const GAMES_BY_ID = Object.assign(
  Object.create(null),
  Object.fromEntries(GAMES.map((g) => [g.id, g])),
)

export function getGameDef(id) {
  return typeof id === 'string' && Object.hasOwn(GAMES_BY_ID, id) ? GAMES_BY_ID[id] : undefined
}

export function normalizeGameSettings(gameId, settings) {
  const def = getGameDef(gameId)
  if (!def) return settings
  const source = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  const next = { ...def.defaultSettings, ...source }

  for (const [key, defaultValue] of Object.entries(def.defaultSettings)) {
    const value = source[key]
    if (typeof defaultValue === 'number') {
      next[key] = typeof value === 'number' && Number.isFinite(value) ? value : defaultValue
    } else if (typeof defaultValue === 'string') {
      next[key] = typeof value === 'string' ? value : defaultValue
    } else if (typeof defaultValue === 'boolean') {
      next[key] = typeof value === 'boolean' ? value : defaultValue
    } else if (value === null || value === undefined) {
      next[key] = defaultValue
    }
  }

  return next
}

/**
 * A game stores the settings it was created with, so one started before a new
 * house rule shipped is missing that key entirely — which reads as `undefined`
 * in the UI and silently scores as 0. Backfill defaults for anything absent,
 * keeping whatever the game already set.
 *
 * Runs on load and on import, so it also covers backups from older versions.
 */
export function migrateState(state) {
  return {
    ...state,
    games: state.games.map((game) => {
      const def = GAMES_BY_ID[game.gameId]
      if (!def) return game
      return { ...game, settings: normalizeGameSettings(game.gameId, game.settings) }
    }),
  }
}

/** Totals + standings + finished state for a saved game. */
export function evaluate(game) {
  const def = getGameDef(game.gameId)
  const normalizedGame = { ...game, settings: normalizeGameSettings(game.gameId, game.settings) }
  const totals = def.computeTotals(normalizedGame)
  const status = def.checkStatus(normalizedGame, totals)
  const standings = normalizedGame.players
    .map((p, index) => ({ player: p, index, ...totals[p.id] }))
    .sort((a, b) => (def.betterIs === 'low' ? a.total - b.total : b.total - a.total))

  let rank = 0
  let prev = null
  standings.forEach((row, i) => {
    if (prev === null || row.total !== prev) rank = i + 1
    prev = row.total
    row.rank = rank
  })

  return { def, totals, standings, status }
}
