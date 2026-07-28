import farkle from './farkle.jsx'
import dutchBlitz from './dutchBlitz.jsx'
import threeThirteen from './threeThirteen.jsx'

export const GAMES = [farkle, dutchBlitz, threeThirteen]

export const GAMES_BY_ID = Object.fromEntries(GAMES.map((g) => [g.id, g]))

export function getGameDef(id) {
  return GAMES_BY_ID[id]
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
