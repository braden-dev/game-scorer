import { GAMES_BY_ID, evaluate, getGameDef } from '../games/index.js'
import { parseTimestamp } from './time.js'

const gameSpecificBuilders = {
  farkle: ({ totals }) => finalTotalMetrics(totals, 'high'),
  'dutch-blitz': ({ totals }) => ({
    ...finalTotalMetrics(totals, 'high'),
    blitzWins: totals.reduce((sum, total) => sum + (total.blitzes || 0), 0),
  }),
  'three-thirteen': ({ totals }) => ({
    ...finalTotalMetrics(totals, 'low'),
    firstOuts: totals.reduce((sum, total) => sum + (total.firsts || 0), 0),
  }),
}

function numberOrNull(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function finalTotalMetrics(totals, betterIs) {
  const values = totals.map(({ total }) => total).filter((total) => total !== null)
  if (!values.length) return { bestFinalTotal: null, averageFinalTotal: null }

  return {
    bestFinalTotal: betterIs === 'low' ? Math.min(...values) : Math.max(...values),
    averageFinalTotal: values.reduce((sum, total) => sum + total, 0) / values.length,
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function knownGameShape(game) {
  return isRecord(game)
    && typeof game.gameId === 'string'
    && Array.isArray(game.players)
    && game.players.every((player) => isRecord(player) && typeof player.id === 'string')
    && isRecord(game.settings)
    && Array.isArray(game.rounds)
    && game.rounds.every((round) => isRecord(round) && isRecord(round.entries))
}

function compareIds(firstId, secondId) {
  return firstId === secondId ? 0 : firstId < secondId ? -1 : 1
}

function knownGameDef(gameId) {
  if (typeof gameId !== 'string' || !Object.hasOwn(GAMES_BY_ID, gameId)) return null
  return getGameDef(gameId)
}

function compareFinishedGames(first, second) {
  const firstFinished = parseTimestamp(first.game.finishedAt)
  const secondFinished = parseTimestamp(second.game.finishedAt)
  const firstCreated = parseTimestamp(first.game.createdAt)
  const secondCreated = parseTimestamp(second.game.createdAt)
  const firstTime = firstFinished ?? firstCreated
  const secondTime = secondFinished ?? secondCreated

  if (firstTime !== null && secondTime !== null && firstTime !== secondTime) return firstTime - secondTime
  if (firstTime === null && secondTime !== null) return 1
  if (firstTime !== null && secondTime === null) return -1
  if (firstCreated !== null && secondCreated !== null && firstCreated !== secondCreated) {
    return firstCreated - secondCreated
  }
  if (firstCreated === null && secondCreated !== null) return 1
  if (firstCreated !== null && secondCreated === null) return -1
  return compareIds(first.game.id || '', second.game.id || '') || first.originalIndex - second.originalIndex
}

function normalizeStandings(evaluated) {
  const standings = Array.isArray(evaluated?.standings) ? evaluated.standings : []
  return standings
    .map((row, index) => {
      const player = row?.player || row
      const id = player?.id || row?.id
      const total = numberOrNull(row?.total ?? evaluated?.totals?.[id]?.total)
      const rank = numberOrNull(row?.rank)
      return id && total !== null ? { id, player, total, rank: rank || index + 1, source: row } : null
    })
    .filter(Boolean)
}

/**
 * Unknown game IDs are ignored. Null or empty inputs produce empty stats.
 * Known games must have the expected players, settings, rounds, and entries
 * shape. Malformed remote records are ignored with a diagnostic; evaluator
 * errors from structurally valid records are intentionally still surfaced.
 */
function evaluatedGames(games) {
  if (!Array.isArray(games)) return []

  return games.flatMap((game, originalIndex) => {
    if (!isRecord(game) || !knownGameDef(game.gameId)) return []
    if (!knownGameShape(game)) {
      console.warn(`[scorebook] Skipping malformed known game ${game?.id ?? 'unknown'} in stats`)
      return []
    }
    const evaluated = evaluate(game)
    if (evaluated?.status?.finished !== true) return []
    const standings = normalizeStandings(evaluated)
    if (!standings.length) return []
    return [{ game, evaluated, standings, originalIndex }]
  }).sort(compareFinishedGames)
}

function playerRow(record, personId) {
  return record.standings.find((row) => row.id === personId) || null
}

function favoriteGame(gameCounts) {
  return [...gameCounts.entries()]
    .sort(([firstId, firstCount], [secondId, secondCount]) => secondCount - firstCount || firstId.localeCompare(secondId))
    .at(0)?.[0] || null
}

function mostPlayedTeammate(teammateCounts) {
  return [...teammateCounts.values()]
    .sort((first, second) => second.games - first.games || first.id.localeCompare(second.id))
    .at(0) || null
}

function buildSummary(personId, records) {
  const personRecords = records
    .map((record) => ({ record, row: playerRow(record, personId) }))
    .filter(({ row }) => row)
  const games = personRecords.length
  const wins = personRecords.filter(({ row }) => row.rank === 1).length
  const gameCounts = new Map()
  const teammateCounts = new Map()
  let totalRank = 0
  let bestFinish = null
  let longestWinStreak = 0
  let currentWinStreak = 0

  for (const { record, row } of personRecords) {
    totalRank += row.rank
    bestFinish = bestFinish === null ? row.rank : Math.min(bestFinish, row.rank)
    gameCounts.set(record.game.gameId, (gameCounts.get(record.game.gameId) || 0) + 1)
    if (row.rank === 1) {
      currentWinStreak += 1
      longestWinStreak = Math.max(longestWinStreak, currentWinStreak)
    } else {
      currentWinStreak = 0
    }

    const seenTeammates = new Set()
    for (const teammate of record.game.players || []) {
      if (!teammate?.id || teammate.id === personId || seenTeammates.has(teammate.id)) continue
      seenTeammates.add(teammate.id)
      const existing = teammateCounts.get(teammate.id) || { id: teammate.id, name: teammate.name || teammate.id, games: 0 }
      existing.games += 1
      teammateCounts.set(teammate.id, existing)
    }
  }

  const teammate = mostPlayedTeammate(teammateCounts)
  return {
    games,
    wins,
    winRate: games ? wins / games : 0,
    averageFinish: games ? totalRank / games : null,
    bestFinish,
    longestWinStreak,
    favoriteGame: favoriteGame(gameCounts),
    mostPlayedTeammate: teammate ? { ...teammate } : null,
  }
}

function gameSpecific(personId, records) {
  const builder = gameSpecificBuilders[records[0].game.gameId]
  if (!builder) return {}

  const totals = records.map(({ evaluated }) => {
    const total = evaluated?.totals?.[personId] || {}
    return { ...total, total: numberOrNull(total.total) }
  })
  return builder({ totals })
}

export function buildPersonStats(personId, games) {
  return buildSummary(personId, evaluatedGames(games))
}

export function buildGameBreakdown(personId, games) {
  const grouped = new Map()
  for (const record of evaluatedGames(games)) {
    if (!playerRow(record, personId)) continue
    const gameId = record.game.gameId
    const records = grouped.get(gameId) || []
    records.push(record)
    grouped.set(gameId, records)
  }

  return [...grouped.entries()]
    .sort(([firstId], [secondId]) => compareIds(firstId, secondId))
    .map(([gameId, records]) => {
    const summary = buildSummary(personId, records)
    return {
      gameId,
      games: summary.games,
      wins: summary.wins,
      winRate: summary.winRate,
      averageFinish: summary.averageFinish,
      gameSpecific: gameSpecific(personId, records),
    }
    })
}

export function buildLeaderboard(games) {
  const records = evaluatedGames(games)
  const people = new Map()
  for (const record of records) {
    for (const player of record.game.players || []) {
      if (player?.id && !people.has(player.id)) people.set(player.id, player)
    }
  }

  const leaderboard = [...people.entries()]
    .map(([personId, player]) => ({
      personId,
      name: player.name || personId,
      ...buildSummary(personId, records),
    }))
    .filter((entry) => entry.games > 0)
    .sort((first, second) => (
      second.wins - first.wins
      || second.winRate - first.winRate
      || (first.averageFinish ?? Infinity) - (second.averageFinish ?? Infinity)
      || first.personId.localeCompare(second.personId)
    ))

  let rank = 1
  return leaderboard.map((entry, index) => {
    const previous = leaderboard[index - 1]
    const tied = previous
      && entry.wins === previous.wins
      && entry.winRate === previous.winRate
      && entry.averageFinish === previous.averageFinish
    if (!tied) rank = index + 1
    return { rank, ...entry }
  })
}
