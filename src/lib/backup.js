const FORMAT = 'gamescorer-backup'
const VERSION = 1
const SUPPORTED_GAME_IDS = new Set(['farkle', 'dutch-blitz', 'three-thirteen'])
const SETTING_TYPES = {
  farkle: {
    target: 'number', opening: 'number', straight: 'number', threePairs: 'number',
    twoTriplets: 'number', multiRule: 'string',
  },
  'dutch-blitz': { target: 'number', blitzPenalty: 'number' },
  'three-thirteen': {
    rounds: 'number', faceValue: 'string', aceValue: 'number', jokerValue: 'number', firstOutBonus: 'number',
  },
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function validSettings(gameId, settings) {
  if (!isRecord(settings)) return false
  return Object.entries(settings).every(([key, value]) => {
    const expectedType = SETTING_TYPES[gameId]?.[key]
    if (!expectedType) return true
    return typeof value === expectedType && (expectedType !== 'number' || Number.isFinite(value))
  })
}

function validPerson(person) {
  return isRecord(person) && validId(person.id) && typeof person.name === 'string' && person.name.trim().length > 0
}

function validPlayer(player) {
  return validPerson(player)
    && (player.seatOrder === undefined || Number.isInteger(player.seatOrder))
}

function validRound(round, playerIds) {
  if (!isRecord(round) || !validId(round.id)) return false
  if (round.roundIndex !== undefined && !Number.isInteger(round.roundIndex)) return false
  if (!isRecord(round.entries)) return false
  return Object.entries(round.entries).every(([playerId, entry]) => playerIds.has(playerId) && isRecord(entry))
}

function validGame(game) {
  if (!isRecord(game) || !validId(game.id) || !SUPPORTED_GAME_IDS.has(game.gameId)) return false
  if (!validSettings(game.gameId, game.settings)) return false
  if (!Array.isArray(game.players) || !Array.isArray(game.rounds)) return false
  if (!game.players.every(validPlayer)) return false
  const playerIds = new Set(game.players.map((player) => player.id))
  if (playerIds.size !== game.players.length) return false
  if (!game.rounds.every((round) => validRound(round, playerIds))) return false
  return new Set(game.rounds.map((round) => round.id)).size === game.rounds.length
}

function filename() {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `game-scorer-${stamp}.json`
}

export function buildBackup(state) {
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      roster: state.roster,
      games: state.games,
    },
    null,
    2,
  )
}

/**
 * Hands the backup to the OS. On phones the share sheet is the only route to
 * something durable (Files, Drive, a message to yourself), so try that first
 * and fall back to a plain download on desktop.
 */
export async function shareOrDownloadBackup(state) {
  const json = buildBackup(state)
  const name = filename()
  const file = new File([json], name, { type: 'application/json' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Game Scorer backup' })
      return 'shared'
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'
      // Fall through to download.
    }
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}

export function parseBackup(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("That file isn't valid JSON.")
  }
  if (data?.format !== FORMAT) throw new Error("That doesn't look like a Game Scorer backup.")
  if (!Array.isArray(data.games) || !Array.isArray(data.roster)) {
    throw new Error('That backup is missing its games or players.')
  }
  const roster = data.roster.filter(validPerson)
  const games = data.games.filter(validGame)
  return {
    ...data,
    roster,
    games,
    invalid: {
      players: data.roster.length - roster.length,
      games: data.games.length - games.length,
    },
  }
}

/**
 * Merges a backup into the current state rather than replacing it, so importing
 * on a device that already has games can't silently destroy them. Anything
 * sharing an id is treated as the same record and left alone.
 */
export function mergeBackup(state, backup) {
  const sourceGames = Array.isArray(backup?.games) ? backup.games : []
  const sourceRoster = Array.isArray(backup?.roster) ? backup.roster : []
  const validGames = sourceGames.filter(validGame)
  const validRoster = sourceRoster.filter(validPerson)
  const invalidGames = (backup?.invalid?.games ?? 0) + sourceGames.length - validGames.length
  const invalidPlayers = (backup?.invalid?.players ?? 0) + sourceRoster.length - validRoster.length
  const gameIds = new Set((Array.isArray(state?.games) ? state.games : []).map((g) => g.id))
  const rosterIds = new Set((Array.isArray(state?.roster) ? state.roster : []).map((p) => p.id))
  const rosterNames = new Set((Array.isArray(state?.roster) ? state.roster : []).map((p) => p.name.toLowerCase()))

  const newGames = validGames.filter((g) => !gameIds.has(g.id))
  const newPlayers = validRoster.filter(
    (p) => !rosterIds.has(p.id) && !rosterNames.has(p.name.toLowerCase()),
  )

  return {
    state: {
      ...state,
      games: [...state.games, ...newGames],
      roster: [...state.roster, ...newPlayers],
    },
    added: { games: newGames.length, players: newPlayers.length },
    skipped: {
      games: validGames.length - newGames.length,
      players: validRoster.length - newPlayers.length,
      invalidGames,
      invalidPlayers,
    },
  }
}
