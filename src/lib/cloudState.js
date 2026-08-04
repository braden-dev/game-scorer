const EPOCH_ISO = new Date(0).toISOString()

function rows(value) {
  return Array.isArray(value) ? value : []
}

function field(row, camelName, snakeName) {
  return row?.[camelName] ?? row?.[snakeName]
}

function timestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (value instanceof Date) {
    const milliseconds = value.getTime()
    return Number.isFinite(milliseconds) ? milliseconds : null
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (!text) return null
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text)
    return Number.isFinite(milliseconds) ? milliseconds : null
  }

  const milliseconds = Date.parse(text)
  return Number.isFinite(milliseconds) ? milliseconds : null
}

function isoTimestamp(value, required = false) {
  const milliseconds = timestamp(value)
  return milliseconds === null ? (required ? EPOCH_ISO : null) : new Date(milliseconds).toISOString()
}

function isTombstone(row) {
  return field(row, 'deletedAt', 'deleted_at') != null
}

function relatedGames(rosterPersonId, games) {
  return games.filter((game) => rows(game.players).some((player) => player?.id === rosterPersonId))
}

export function normalizeName(name) {
  return String(name ?? '').trim().toLocaleLowerCase()
}

export function toRemoteRows(state) {
  const roster = rows(state?.roster)
  const sourceGames = rows(state?.games)

  const games = sourceGames.map((game) => ({
    id: game.id,
    game_id: game.gameId,
    created_at: isoTimestamp(field(game, 'createdAt', 'created_at'), true),
    updated_at: isoTimestamp(field(game, 'updatedAt', 'updated_at'), true),
    finished_at: isoTimestamp(field(game, 'finishedAt', 'finished_at')),
    settings: game.settings ?? {},
    deleted_at: isoTimestamp(field(game, 'deletedAt', 'deleted_at')),
  }))

  const people = roster.map((person) => {
    const related = relatedGames(person.id, sourceGames)
    const createdAt = timestamp(field(person, 'createdAt', 'created_at'))
      ?? related.reduce((earliest, game) => {
        const value = timestamp(field(game, 'createdAt', 'created_at'))
        return value === null ? earliest : Math.min(earliest, value)
      }, Number.POSITIVE_INFINITY)
    const createdMilliseconds = Number.isFinite(createdAt) ? createdAt : 0
    const updatedAt = timestamp(field(person, 'updatedAt', 'updated_at'))
      ?? related.reduce((latest, game) => {
        const value = timestamp(field(game, 'updatedAt', 'updated_at'))
        return value === null ? latest : Math.max(latest, value)
      }, createdMilliseconds)

    return {
      id: person.id,
      name: person.name,
      normalized_name: normalizeName(person.name),
      created_at: isoTimestamp(createdMilliseconds, true),
      updated_at: isoTimestamp(updatedAt, true),
      deleted_at: isoTimestamp(field(person, 'deletedAt', 'deleted_at')),
    }
  })

  const gamePlayers = sourceGames.flatMap((game) => rows(game.players).map((player, seatOrder) => ({
    game_id: game.id,
    person_id: player.id,
    seat_order: seatOrder,
    name_snapshot: player.name,
    updated_at: isoTimestamp(field(game, 'updatedAt', 'updated_at'), true),
    deleted_at: null,
  })))

  const rounds = sourceGames.flatMap((game) => rows(game.rounds).map((round, roundIndex) => ({
    id: round.id,
    game_id: game.id,
    round_index: roundIndex,
    entries: round.entries ?? {},
    updated_at: isoTimestamp(
      field(round, 'updatedAt', 'updated_at') ?? field(game, 'updatedAt', 'updated_at'),
      true,
    ),
    deleted_at: isoTimestamp(field(round, 'deletedAt', 'deleted_at')),
  })))

  return { people, games, gamePlayers, rounds }
}

export function fromRemoteRows({ people, games, gamePlayers, rounds } = {}, activeGameId = null) {
  const visiblePeople = rows(people).filter((person) => !isTombstone(person))
  const peopleById = new Map(visiblePeople.map((person) => [person.id, person]))
  const visibleGames = rows(games).filter((game) => !isTombstone(game))
  const visibleGameIds = new Set(visibleGames.map((game) => game.id))

  const playersByGameId = new Map()
  for (const player of rows(gamePlayers)) {
    if (isTombstone(player) || !visibleGameIds.has(player.game_id)) continue
    const gamePlayersForGame = playersByGameId.get(player.game_id) ?? []
    gamePlayersForGame.push(player)
    playersByGameId.set(player.game_id, gamePlayersForGame)
  }

  const roundsByGameId = new Map()
  for (const round of rows(rounds)) {
    if (isTombstone(round) || !visibleGameIds.has(round.game_id)) continue
    const roundsForGame = roundsByGameId.get(round.game_id) ?? []
    roundsForGame.push(round)
    roundsByGameId.set(round.game_id, roundsForGame)
  }

  const roster = visiblePeople.map((person) => ({ id: person.id, name: person.name }))
  const nestedGames = visibleGames.map((game) => {
    const players = (playersByGameId.get(game.id) ?? [])
      .slice()
      .sort((a, b) => (a.seat_order ?? 0) - (b.seat_order ?? 0))
      .map((player) => ({
        id: player.person_id,
        name: peopleById.get(player.person_id)?.name ?? player.name_snapshot,
      }))
    const nestedRounds = (roundsByGameId.get(game.id) ?? [])
      .slice()
      .sort((a, b) => (a.round_index ?? 0) - (b.round_index ?? 0))
      .map((round) => ({ id: round.id, entries: round.entries ?? {} }))

    return {
      id: game.id,
      gameId: game.game_id,
      createdAt: timestamp(field(game, 'createdAt', 'created_at')),
      updatedAt: timestamp(field(game, 'updatedAt', 'updated_at')),
      players,
      settings: game.settings ?? {},
      rounds: nestedRounds,
      finishedAt: timestamp(field(game, 'finishedAt', 'finished_at')),
    }
  })

  return { games: nestedGames, roster, activeGameId }
}
