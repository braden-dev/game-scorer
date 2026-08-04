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
      return { ...game, settings: { ...def.defaultSettings, ...game.settings } }
    }),
  }
}

/** Totals + standings + finished state for a saved game. */
export function evaluate(game) {
  const def = getGameDef(game.gameId)
  const totals = def.computeTotals(game)
  const status = def.checkStatus(game, totals)
  const standings = game.players
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
