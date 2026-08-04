const EPOCH_ISO = new Date(0).toISOString()
const CLOUD_METADATA = Symbol.for('gamescorer.cloudMetadata')

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
    return validMilliseconds(milliseconds)
  }
  if (typeof value === 'number') return validMilliseconds(value)
  if (typeof value !== 'string') return null

  const text = value.trim()
  if (!text) return null
  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    const milliseconds = Number(text)
    return validMilliseconds(milliseconds)
  }

  const milliseconds = Date.parse(text)
  return validMilliseconds(milliseconds)
}

function isoTimestamp(value, required = false) {
  const milliseconds = timestamp(value)
  if (milliseconds === null) return required ? EPOCH_ISO : null
  try {
    return new Date(milliseconds).toISOString()
  } catch {
    return required ? EPOCH_ISO : null
  }
}

function validMilliseconds(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  return Number.isFinite(date.getTime()) ? milliseconds : null
}

function isTombstone(row) {
  return field(row, 'deletedAt', 'deleted_at') != null
}

function withTimestamps(record, updatedAt, createdAt = undefined) {
  Object.defineProperty(record, 'updatedAt', {
    value: updatedAt,
    configurable: true,
    writable: true,
  })
  if (createdAt !== undefined) {
    Object.defineProperty(record, 'createdAt', {
      value: createdAt,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function withVersion(record, updatedAt) {
  return withTimestamps(record, updatedAt)
}

function withPlayerMetadata(record, seatOrder, nameSnapshot) {
  if (seatOrder !== undefined) {
    Object.defineProperty(record, 'seatOrder', {
      value: seatOrder,
      configurable: true,
      writable: true,
    })
  }
  if (nameSnapshot !== undefined) {
    Object.defineProperty(record, 'nameSnapshot', {
      value: nameSnapshot,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function withRoundMetadata(record, roundIndex) {
  if (roundIndex !== undefined) {
    Object.defineProperty(record, 'roundIndex', {
      value: roundIndex,
      configurable: true,
      writable: true,
    })
  }
  return record
}

function tombstoneRecord(row, id, parentId = null) {
  const record = {
    ...(parentId === null ? {} : { gameId: parentId }),
    id,
    updatedAt: timestamp(field(row, 'updatedAt', 'updated_at')),
    deletedAt: field(row, 'deletedAt', 'deleted_at'),
  }
  if (row?.name !== undefined) record.name = row.name
  if (row?.normalized_name !== undefined) record.normalizedName = row.normalized_name
  if (row?.created_at !== undefined || row?.createdAt !== undefined) {
    record.createdAt = timestamp(field(row, 'createdAt', 'created_at'))
  }
  if (parentId === null && row?.game_id !== undefined) record.gameId = row.game_id
  if (row?.settings !== undefined) record.settings = row.settings
  if (row?.finished_at !== undefined || row?.finishedAt !== undefined) {
    record.finishedAt = timestamp(field(row, 'finishedAt', 'finished_at'))
  }
  if (row?.seat_order !== undefined) record.seatOrder = row.seat_order
  if (row?.name_snapshot !== undefined) record.nameSnapshot = row.name_snapshot
  if (row?.round_index !== undefined) record.roundIndex = row.round_index
  if (row?.entries !== undefined) record.entries = row.entries
  return record
}

function setMetadata(state, metadata) {
  Object.defineProperty(state, CLOUD_METADATA, {
    value: metadata,
    configurable: true,
  })
  return state
}

export function copyCloudMetadata(target, source) {
  const metadata = source?.[CLOUD_METADATA]
  if (metadata === undefined) return target
  Object.defineProperty(target, CLOUD_METADATA, {
    value: metadata,
    configurable: true,
  })
  return target
}

export function hasCloudMetadata(state) {
  return state?.[CLOUD_METADATA] !== undefined
}

export function mergeCloudCache(cache, state) {
  const next = {
    ...(state ?? { games: [], roster: [] }),
    games: Array.isArray(state?.games) ? state.games : [],
    roster: Array.isArray(state?.roster) ? state.roster : [],
    activeGameId: state?.activeGameId ?? null,
  }
  copyCloudMetadata(next, state)
  copyCloudMetadata(next, cache)
  return next
}

function mutationEntity(entity) {
  if (entity === 'game_players' || entity === 'gamePlayers') return 'gamePlayers'
  return entity
}

function mutationPart(id, camelName, snakeName) {
  if (id && typeof id === 'object') return id[camelName] ?? id[snakeName]
  return camelName === 'id' ? id : undefined
}

function addCloudTombstone(metadata, group, record) {
  const records = metadataRecords(metadata, group)
  const same = records.filter((candidate) => {
    if (group === 'gamePlayers' || group === 'rounds') {
      return candidate.gameId === record.gameId && candidate.id === record.id
    }
    return candidate.id === record.id
  })
  if (same.some((candidate) => tombstoneVersion(candidate) > tombstoneVersion(record))) return records
  return [...records.filter((candidate) => !same.includes(candidate)), record]
}

/**
 * Round soft-delete payloads may include { gameId, roundIndex, entries } while
 * entityId remains the scalar round id sent to the cloud API.
 */
export function applyCloudSoftDelete(cache, entity, id, updatedAt, details = null) {
  const source = cache && typeof cache === 'object' ? cache : { games: [], roster: [], activeGameId: null }
  const group = mutationEntity(entity)
  const version = timestamp(updatedAt)
  const tombstone = { updatedAt: version, deletedAt: updatedAt }
  const metadata = source[CLOUD_METADATA] ?? {}
  const nextMetadata = {
    roster: rows(metadata.roster).slice(),
    games: rows(metadata.games).slice(),
    gamePlayers: rows(metadata.gamePlayers).slice(),
    rounds: rows(metadata.rounds).slice(),
  }
  let nextGames = rows(source.games)
  let nextRoster = rows(source.roster)

  if (group === 'people') {
    const personId = mutationPart(id, 'id', 'id')
    const priorPerson = nextRoster.find((person) => person.id === personId)
      ?? metadataRecords(metadata, 'roster').find((person) => person.id === personId)
    nextRoster = nextRoster.filter((person) => person.id !== personId)
    const deletedPerson = { ...priorPerson, ...tombstone, id: personId }
    const priorCreatedAt = field(priorPerson, 'createdAt', 'created_at')
    if (priorCreatedAt !== undefined) deletedPerson.createdAt = priorCreatedAt
    nextMetadata.roster = addCloudTombstone(nextMetadata, 'roster', deletedPerson)
  } else if (group === 'games') {
    const gameId = mutationPart(id, 'id', 'id')
    const priorGame = nextGames.find((game) => game.id === gameId)
    nextGames = nextGames.filter((game) => game.id !== gameId)
    nextMetadata.games = addCloudTombstone(nextMetadata, 'games', { ...priorGame, ...tombstone, id: gameId })
  } else if (group === 'gamePlayers' || group === 'rounds') {
    const roundDetails = group === 'rounds' && details && typeof details === 'object' ? details : null
    const playerDetails = group === 'gamePlayers' && details && typeof details === 'object' ? details : null
    const requestedId = mutationPart(id, group === 'gamePlayers' ? 'personId' : 'id', group === 'gamePlayers' ? 'person_id' : 'id')
    const priorRound = group === 'rounds'
      ? metadataRecords(metadata, 'rounds')
        .filter((record) => record.id === requestedId && record.gameId != null)
        .reduce((latest, record) => (
          !latest || tombstoneVersion(record) >= tombstoneVersion(latest) ? record : latest
        ), null)
      : null
    const requestedGameId = mutationPart(id, 'gameId', 'game_id')
      ?? mutationPart(roundDetails, 'gameId', 'game_id')
      ?? priorRound?.gameId
    const requestedRoundIndex = roundDetails?.roundIndex ?? roundDetails?.round_index ?? priorRound?.roundIndex
    const requestedEntries = roundDetails?.entries ?? priorRound?.entries
    const records = []
    nextGames = nextGames.map((game) => {
      if (requestedGameId != null && game.id !== requestedGameId) return game
      if (group === 'gamePlayers') {
        const players = rows(game.players)
        const matched = players.filter((player) => player.id === requestedId)
        if (matched.length) {
          const player = matched[0]
          records.push({
            ...player,
            ...tombstone,
            gameId: game.id,
            id: requestedId,
            seatOrder: playerDetails?.seatOrder ?? player.seatOrder,
            nameSnapshot: playerDetails?.nameSnapshot ?? player.nameSnapshot ?? player.name,
          })
        }
        return matched.length ? { ...game, players: players.filter((player) => player.id !== requestedId) } : game
      }
      const rounds = rows(game.rounds)
      const matched = rounds.filter((round) => round.id === requestedId)
      if (matched.length) {
        const round = matched[0]
        records.push({
          ...tombstone,
          gameId: game.id,
          id: requestedId,
          roundIndex: requestedRoundIndex ?? field(round, 'roundIndex', 'round_index'),
          entries: requestedEntries ?? round.entries ?? {},
        })
      }
      return matched.length ? { ...game, rounds: rounds.filter((round) => round.id !== requestedId) } : game
    })
    if (records.length === 0) {
      const record = { ...tombstone, gameId: requestedGameId ?? null, id: requestedId }
      if (group === 'gamePlayers') {
        record.seatOrder = playerDetails?.seatOrder
        record.nameSnapshot = playerDetails?.nameSnapshot
      } else if (group === 'rounds') {
        record.roundIndex = requestedRoundIndex
        record.entries = requestedEntries ?? {}
      }
      records.push(record)
    }
    for (const record of records) nextMetadata[group] = addCloudTombstone(nextMetadata, group, record)
  }

  return setMetadata({ ...source, games: nextGames, roster: nextRoster }, nextMetadata)
}

function metadataRecords(metadata, key) {
  return rows(metadata?.[key])
}

function childPlayerMetadata(player, peopleById) {
  return withPlayerMetadata(withVersion({
    gameId: player.game_id,
    id: player.person_id,
    name: peopleById.get(player.person_id)?.name ?? player.name_snapshot,
  }, timestamp(field(player, 'updatedAt', 'updated_at'))), player.seat_order, player.name_snapshot)
}

function childRoundMetadata(round) {
  return withRoundMetadata(withVersion({
    gameId: round.game_id,
    id: round.id,
    entries: round.entries ?? {},
  }, timestamp(field(round, 'updatedAt', 'updated_at'))), round.round_index)
}

function latestPlayerTombstone(metadata, gameId, personId) {
  return metadataRecords(metadata, 'gamePlayers')
    .filter((record) => record.gameId === gameId && record.id === personId && isTombstone(record))
    .reduce((latest, record) => {
      if (!latest) return record
      const latestVersion = tombstoneVersion(latest)
      const recordVersion = tombstoneVersion(record)
      return recordVersion >= latestVersion ? record : latest
    }, null)
}

function latestRoundTombstone(metadata, gameId, roundId) {
  return metadataRecords(metadata, 'rounds')
    .filter((record) => record.gameId === gameId && record.id === roundId && isTombstone(record))
    .reduce((latest, record) => {
      if (!latest) return record
      return tombstoneVersion(record) >= tombstoneVersion(latest) ? record : latest
    }, null)
}

function playerVersion(player, game) {
  return timestamp(field(player, 'updatedAt', 'updated_at'))
    ?? timestamp(field(game, 'updatedAt', 'updated_at'))
    ?? 0
}

function tombstoneVersion(tombstone) {
  const timestamps = [
    timestamp(field(tombstone, 'updatedAt', 'updated_at')),
    timestamp(field(tombstone, 'deletedAt', 'deleted_at')),
  ].filter((value) => value !== null)
  return timestamps.length ? Math.max(...timestamps) : 0
}

export function normalizeName(name) {
  return String(name ?? '').trim().toLocaleLowerCase()
}

function addPersonCandidate(candidates, candidate) {
  if (candidate?.id == null) return
  const previous = candidates.get(candidate.id)
  if (!previous) {
    candidates.set(candidate.id, {
      ...candidate,
      createdAt: timestamp(candidate.createdAt),
      updatedAt: timestamp(candidate.updatedAt) ?? timestamp(candidate.createdAt) ?? 0,
    })
    return
  }

  const candidateUpdatedAt = timestamp(candidate.updatedAt) ?? timestamp(candidate.createdAt) ?? 0
  const candidateNameWins = candidate.sourcePriority > previous.sourcePriority
    || (candidate.sourcePriority === previous.sourcePriority && candidateUpdatedAt >= previous.updatedAt)
  candidates.set(candidate.id, {
    ...previous,
    name: candidateNameWins ? candidate.name : previous.name,
    sourcePriority: candidateNameWins ? candidate.sourcePriority : previous.sourcePriority,
    createdAt: [previous.createdAt, timestamp(candidate.createdAt)].filter((value) => value !== null).reduce(
      (earliest, value) => Math.min(earliest, value),
      Number.POSITIVE_INFINITY,
    ),
    updatedAt: Math.max(previous.updatedAt, candidateUpdatedAt),
  })
}

export function toRemoteRows(state) {
  const roster = rows(state?.roster)
  const sourceGames = rows(state?.games)
  const metadata = state?.[CLOUD_METADATA] ?? {}
  const personCandidates = new Map()
  for (const person of roster) {
    addPersonCandidate(personCandidates, {
      id: person.id,
      name: person.name,
      createdAt: field(person, 'createdAt', 'created_at'),
      updatedAt: field(person, 'updatedAt', 'updated_at'),
      sourcePriority: 2,
    })
  }
  for (const game of sourceGames) {
    for (const player of rows(game.players)) {
      addPersonCandidate(personCandidates, {
        id: player.id,
        name: player.name,
        createdAt: field(player, 'createdAt', 'created_at') ?? field(game, 'createdAt', 'created_at'),
        updatedAt: field(player, 'updatedAt', 'updated_at') ?? field(game, 'updatedAt', 'updated_at'),
        sourcePriority: 1,
      })
    }
  }
  const livePersonIds = new Set(personCandidates.keys())
  const liveGameIds = new Set(sourceGames.map((game) => game.id))

  const liveGames = sourceGames.map((game) => ({
    id: game.id,
    game_id: game.gameId,
    created_at: isoTimestamp(field(game, 'createdAt', 'created_at'), true),
    updated_at: isoTimestamp(field(game, 'updatedAt', 'updated_at'), true),
    finished_at: isoTimestamp(field(game, 'finishedAt', 'finished_at')),
    settings: game.settings ?? {},
    deleted_at: isoTimestamp(field(game, 'deletedAt', 'deleted_at')),
  }))
  const deletedGames = metadataRecords(metadata, 'games')
    .filter((game) => isTombstone(game) && !liveGameIds.has(game.id))
    .map((game) => ({
      id: game.id,
      game_id: field(game, 'gameId', 'game_id') ?? null,
      created_at: isoTimestamp(field(game, 'createdAt', 'created_at'), true),
      updated_at: isoTimestamp(
        field(game, 'updatedAt', 'updated_at') ?? field(game, 'deletedAt', 'deleted_at'),
        true,
      ),
      finished_at: isoTimestamp(field(game, 'finishedAt', 'finished_at')),
      settings: game.settings ?? {},
      deleted_at: isoTimestamp(field(game, 'deletedAt', 'deleted_at')),
    }))
  const games = [...liveGames, ...deletedGames]

  const livePeople = [...personCandidates.values()].map((person) => {
    const tombstone = metadataRecords(metadata, 'roster')
      .filter((record) => record.id === person.id && isTombstone(record))
      .reduce((latest, record) => (!latest || tombstoneVersion(record) >= tombstoneVersion(latest) ? record : latest), null)
    const deleted = tombstone && tombstoneVersion(tombstone) >= person.updatedAt ? tombstone : null
    const createdMilliseconds = Number.isFinite(person.createdAt) ? person.createdAt : 0

    return {
      id: person.id,
      name: person.name,
      normalized_name: normalizeName(person.name),
      created_at: isoTimestamp(createdMilliseconds, true),
      updated_at: isoTimestamp(deleted ? field(deleted, 'updatedAt', 'updated_at') ?? field(deleted, 'deletedAt', 'deleted_at') : person.updatedAt, true),
      deleted_at: isoTimestamp(field(deleted, 'deletedAt', 'deleted_at')),
    }
  })
  const deletedPeople = metadataRecords(metadata, 'roster')
    .filter((person) => isTombstone(person) && !livePersonIds.has(person.id))
    .map((person) => ({
      id: person.id,
      name: person.name ?? '',
      normalized_name: person.normalizedName ?? normalizeName(person.name),
      created_at: isoTimestamp(field(person, 'createdAt', 'created_at'), true),
      updated_at: isoTimestamp(
        field(person, 'updatedAt', 'updated_at') ?? field(person, 'deletedAt', 'deleted_at'),
        true,
      ),
      deleted_at: isoTimestamp(field(person, 'deletedAt', 'deleted_at')),
    }))
  const people = [...livePeople, ...deletedPeople]

  const gamePlayers = sourceGames.flatMap((game) => {
    const players = rows(game.players)
    const tombstones = metadataRecords(metadata, 'gamePlayers')
      .filter((record) => record.gameId === game.id && isTombstone(record))
    const currentIds = new Set(players.map((player) => player.id))
    const liveRows = players.map((player, seatOrder) => {
      const tombstone = latestPlayerTombstone(metadata, game.id, player.id)
      const liveVersion = playerVersion(player, game)
      const deleted = tombstone && tombstoneVersion(tombstone) >= liveVersion ? tombstone : null
      return {
        game_id: game.id,
        person_id: player.id,
        seat_order: field(deleted, 'seatOrder', 'seat_order') ?? field(player, 'seatOrder', 'seat_order') ?? seatOrder,
        name_snapshot: field(deleted, 'nameSnapshot', 'name_snapshot') ?? field(player, 'nameSnapshot', 'name_snapshot') ?? player.name,
        updated_at: isoTimestamp(
          deleted ? field(deleted, 'updatedAt', 'updated_at') ?? field(deleted, 'deletedAt', 'deleted_at') : field(player, 'updatedAt', 'updated_at') ?? field(game, 'updatedAt', 'updated_at'),
          true,
        ),
        deleted_at: isoTimestamp(deleted ? field(deleted, 'deletedAt', 'deleted_at') : field(player, 'deletedAt', 'deleted_at')),
      }
    })
    const deletedRows = tombstones
      .filter((tombstone) => !currentIds.has(tombstone.id))
      .map((tombstone) => ({
        game_id: game.id,
        person_id: tombstone.id,
        seat_order: tombstone.seatOrder ?? 0,
        name_snapshot: tombstone.nameSnapshot ?? roster.find((person) => person.id === tombstone.id)?.name ?? 'Unknown',
        updated_at: isoTimestamp(field(tombstone, 'updatedAt', 'updated_at') ?? field(tombstone, 'deletedAt', 'deleted_at'), true),
        deleted_at: isoTimestamp(field(tombstone, 'deletedAt', 'deleted_at')),
      }))
    return [...liveRows, ...deletedRows]
  })

  const rounds = sourceGames.flatMap((game) => {
    const sourceRounds = rows(game.rounds)
    const tombstones = metadataRecords(metadata, 'rounds')
      .filter((record) => record.gameId === game.id && isTombstone(record))
    const currentIds = new Set(sourceRounds.map((round) => round.id))
    const liveRows = sourceRounds.map((round, roundIndex) => {
      const tombstone = latestRoundTombstone(metadata, game.id, round.id)
      const liveVersion = timestamp(field(round, 'updatedAt', 'updated_at'))
        ?? timestamp(field(game, 'updatedAt', 'updated_at'))
        ?? 0
      const deleted = tombstone && tombstoneVersion(tombstone) >= liveVersion ? tombstone : null
      return {
        id: round.id,
        game_id: game.id,
        round_index: field(deleted, 'roundIndex', 'round_index') ?? field(round, 'roundIndex', 'round_index') ?? roundIndex,
        entries: field(deleted, 'entries', 'entries') ?? round.entries ?? {},
        updated_at: isoTimestamp(
          deleted
            ? field(deleted, 'updatedAt', 'updated_at') ?? field(deleted, 'deletedAt', 'deleted_at')
            : field(round, 'updatedAt', 'updated_at') ?? field(game, 'updatedAt', 'updated_at'),
          true,
        ),
        deleted_at: isoTimestamp(field(deleted, 'deletedAt', 'deleted_at') ?? field(round, 'deletedAt', 'deleted_at')),
      }
    })
    const deletedRows = tombstones
      .filter((tombstone) => !currentIds.has(tombstone.id))
      .map((tombstone) => ({
        id: tombstone.id,
        game_id: game.id,
        round_index: tombstone.roundIndex ?? 0,
        entries: tombstone.entries ?? {},
        updated_at: isoTimestamp(
          field(tombstone, 'updatedAt', 'updated_at') ?? field(tombstone, 'deletedAt', 'deleted_at'),
          true,
        ),
        deleted_at: isoTimestamp(field(tombstone, 'deletedAt', 'deleted_at')),
      }))
    return [...liveRows, ...deletedRows]
  })

  return { people, games, gamePlayers, rounds }
}

export function migrationCounts(state) {
  const games = rows(state?.games)
  const remoteRows = toRemoteRows(state)
  return {
    games: games.length,
    rounds: games.reduce((sum, game) => sum + rows(game.rounds).length, 0),
    people: remoteRows.people.length,
  }
}

export function toRemoteRowsDelta(state, previousState = {}, options = {}) {
  const previousGames = new Map(rows(previousState.games).map((game) => [game.id, game]))
  const previousPeople = new Map(rows(previousState.roster).map((person) => [person.id, person]))
  const changedGames = rows(state?.games)
    .filter((game) => previousGames.get(game.id) !== game)
    .map((game) => {
      if (options.gameId !== game.id) return game
      const scoped = { ...game }
      if (Array.isArray(options.roundIds)) {
        const roundIds = new Set(options.roundIds)
        scoped.rounds = rows(game.rounds)
          .map((round, roundIndex) => roundIds.has(round.id) ? {
            ...round,
            roundIndex: field(round, 'roundIndex', 'round_index') ?? roundIndex,
          } : null)
          .filter(Boolean)
      }
      if (Array.isArray(options.playerIds)) {
        const playerIds = new Set(options.playerIds)
        scoped.players = rows(game.players)
          .map((player, seatOrder) => playerIds.has(player.id) ? {
            ...player,
            seatOrder: field(player, 'seatOrder', 'seat_order') ?? seatOrder,
          } : null)
          .filter(Boolean)
      }
      return scoped
    })
  const changedPeople = rows(state?.roster).filter((person) => previousPeople.get(person.id) !== person)
  const referencedPeople = new Set(changedGames.flatMap((game) => rows(game.players).map((player) => player.id)))
  const people = [...new Map(
    [...changedPeople, ...rows(state?.roster).filter((person) => referencedPeople.has(person.id))]
      .map((person) => [person.id, person]),
  ).values()]

  const remoteRows = toRemoteRows({ ...state, games: changedGames, roster: people })
  if (options.includeGame === false) remoteRows.games = []
  return remoteRows
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

  const roster = visiblePeople.map((person) => withTimestamps(
    { id: person.id, name: person.name },
    timestamp(field(person, 'updatedAt', 'updated_at')),
    timestamp(field(person, 'createdAt', 'created_at')),
  ))
  const nestedGames = visibleGames.map((game) => {
    const players = (playersByGameId.get(game.id) ?? [])
      .slice()
      .sort((a, b) => (a.seat_order ?? 0) - (b.seat_order ?? 0))
      .map((player) => withPlayerMetadata(withVersion({
        id: player.person_id,
        name: peopleById.get(player.person_id)?.name ?? player.name_snapshot,
      }, timestamp(field(player, 'updatedAt', 'updated_at'))), player.seat_order, player.name_snapshot))
    const nestedRounds = (roundsByGameId.get(game.id) ?? [])
      .slice()
      .sort((a, b) => (a.round_index ?? 0) - (b.round_index ?? 0))
      .map((round) => withRoundMetadata(withVersion(
        { id: round.id, entries: round.entries ?? {} },
        timestamp(field(round, 'updatedAt', 'updated_at')),
      ), round.round_index))

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

  return setMetadata({ games: nestedGames, roster, activeGameId }, {
    roster: rows(people)
      .filter(isTombstone)
      .map((person) => tombstoneRecord(person, person.id)),
    games: rows(games)
      .filter(isTombstone)
      .map((game) => tombstoneRecord(game, game.id)),
    gamePlayers: [
      ...rows(gamePlayers)
        .filter(isTombstone)
        .map((player) => tombstoneRecord(player, player.person_id, player.game_id)),
      ...rows(gamePlayers)
        .filter((player) => !isTombstone(player) && !visibleGameIds.has(player.game_id))
        .map((player) => childPlayerMetadata(player, peopleById)),
    ],
    rounds: [
      ...rows(rounds)
        .filter(isTombstone)
        .map((round) => tombstoneRecord(round, round.id, round.game_id)),
      ...rows(rounds)
        .filter((round) => !isTombstone(round) && !visibleGameIds.has(round.game_id))
        .map(childRoundMetadata),
    ],
  })
}
