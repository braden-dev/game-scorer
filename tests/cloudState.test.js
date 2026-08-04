import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCloudSoftDelete, copyCloudMetadata, filterRowsAlreadyInCloud, fromRemoteRows, mergeMigrationState, migrationCounts, normalizeName, toRemoteRows, toRemoteRowsDelta } from '../src/lib/cloudState.js'

test('normalizes names by trimming and locale-lowercasing', () => {
  assert.equal(normalizeName('  Jöhn DOE  '), 'jöhn doe')
})

test('converts nested state into timestamped remote rows with ISO timestamps', () => {
  const state = {
    roster: [{ id: 'p_john', name: ' John ' }],
    games: [{
      id: 'g_one',
      gameId: 'farkle',
      createdAt: 100,
      updatedAt: 200,
      players: [{ id: 'p_john', name: 'John' }],
      settings: { target: 10000 },
      rounds: [{ id: 'r_one', updatedAt: 250, entries: { p_john: { score: 500 } } }],
      finishedAt: 300,
    }],
  }

  assert.deepEqual(toRemoteRows(state), {
    people: [{
      id: 'p_john',
      name: ' John ',
      normalized_name: 'john',
      created_at: '1970-01-01T00:00:00.100Z',
      updated_at: '1970-01-01T00:00:00.200Z',
      deleted_at: null,
    }],
    games: [{
      id: 'g_one',
      game_id: 'farkle',
      created_at: '1970-01-01T00:00:00.100Z',
      updated_at: '1970-01-01T00:00:00.200Z',
      finished_at: '1970-01-01T00:00:00.300Z',
      settings: { target: 10000 },
      deleted_at: null,
    }],
    gamePlayers: [{
      game_id: 'g_one',
      person_id: 'p_john',
      seat_order: 0,
      name_snapshot: 'John',
      updated_at: '1970-01-01T00:00:00.200Z',
      deleted_at: null,
    }],
    rounds: [{
      id: 'r_one',
      game_id: 'g_one',
      round_index: 0,
      entries: { p_john: { score: 500 } },
      updated_at: '1970-01-01T00:00:00.250Z',
      deleted_at: null,
    }],
  })

  const rows = toRemoteRows(state)
  assert.equal(typeof rows.games[0].created_at, 'string')
  assert.equal(rows.games[0].updated_at, '1970-01-01T00:00:00.200Z')
})

test('emits a people row for historical game players missing from the roster', () => {
  const rows = toRemoteRows({
    roster: [],
    games: [{
      id: 'g_history',
      gameId: 'farkle',
      createdAt: 100,
      updatedAt: 200,
      players: [{ id: 'p_history', name: 'Historical Player' }],
      settings: {},
      rounds: [],
      finishedAt: null,
    }],
  })

  assert.deepEqual(rows.people.map(({ id, name }) => ({ id, name })), [
    { id: 'p_history', name: 'Historical Player' },
  ])
  assert.equal(rows.gamePlayers[0].person_id, 'p_history')
})

test('migration counts match deduplicated published people, including historical players', () => {
  const state = {
    roster: [{ id: 'p_roster', name: 'Roster Player' }],
    games: [
      {
        id: 'g_one',
        gameId: 'farkle',
        createdAt: 100,
        updatedAt: 100,
        players: [
          { id: 'p_roster', name: 'Roster Player' },
          { id: 'p_history', name: 'Historical Player' },
        ],
        settings: {},
        rounds: [{ id: 'r_one', entries: {} }],
        finishedAt: null,
      },
      {
        id: 'g_two',
        gameId: 'farkle',
        createdAt: 200,
        updatedAt: 200,
        players: [{ id: 'p_history', name: 'Historical Player' }],
        settings: {},
        rounds: [],
        finishedAt: null,
      },
    ],
  }

  assert.deepEqual(migrationCounts(state), { games: 2, rounds: 1, people: 2, skippedGames: 0 })
})

test('migration skips unsupported games while retaining roster and supported-game players', () => {
  const state = {
    roster: [{ id: 'p_roster', name: 'Roster Player' }],
    games: [
      {
        id: 'g_supported',
        gameId: 'farkle',
        createdAt: 100,
        updatedAt: 200,
        players: [{ id: 'p_supported', name: 'Supported Player' }],
        settings: {},
        rounds: [{ id: 'r_supported', entries: {} }],
        finishedAt: null,
      },
      {
        id: 'g_future',
        gameId: 'future-game',
        createdAt: 300,
        updatedAt: 400,
        players: [{ id: 'p_future', name: 'Future Player' }],
        settings: {},
        rounds: [{ id: 'r_future', entries: {} }],
        finishedAt: null,
      },
    ],
  }

  const rows = toRemoteRows(state)
  assert.deepEqual(rows.games.map(({ id, game_id }) => [id, game_id]), [['g_supported', 'farkle']])
  assert.deepEqual(rows.gamePlayers.map(({ game_id, person_id }) => [game_id, person_id]), [['g_supported', 'p_supported']])
  assert.deepEqual(rows.rounds.map(({ game_id, id }) => [game_id, id]), [['g_supported', 'r_supported']])
  assert.deepEqual(rows.people.map(({ id }) => id), ['p_roster', 'p_supported'])
  assert.deepEqual(migrationCounts(state), { games: 1, rounds: 1, people: 2, skippedGames: 1 })
})

test('migration omits unsupported game tombstones from cloud rows', () => {
  const state = fromRemoteRows({
    people: [],
    games: [{
      id: 'g_future_deleted',
      game_id: 'future-game',
      updated_at: '2026-01-02T00:00:00.000Z',
      deleted_at: '2026-01-03T00:00:00.000Z',
      settings: {},
    }],
    gamePlayers: [],
    rounds: [],
  })

  assert.deepEqual(toRemoteRows(state), { people: [], games: [], gamePlayers: [], rounds: [] })
})

test('first-run migration filters rows whose identities already exist in cloud', () => {
  const localRows = {
    people: [
      { id: 'p_existing', name: 'Local stale name' },
      { id: 'p_new', name: 'New player' },
    ],
    games: [
      { id: 'g_existing', game_id: 'farkle', settings: { target: 100 }, updated_at: '2026-01-02T00:00:00.000Z' },
      { id: 'g_new', game_id: 'farkle', settings: { target: 100 }, updated_at: '2026-01-02T00:00:00.000Z' },
    ],
    gamePlayers: [
      { game_id: 'g_existing', person_id: 'p_existing', seat_order: 0 },
      { game_id: 'g_new', person_id: 'p_new', seat_order: 0 },
    ],
    rounds: [
      { id: 'r_existing', game_id: 'g_existing', round_index: 0, entries: {} },
      { id: 'r_new', game_id: 'g_new', round_index: 0, entries: {} },
    ],
  }
  const cloudRows = {
    people: [{ id: 'p_existing', name: 'Shared name' }],
    games: [{ id: 'g_existing', game_id: 'farkle', settings: { target: 100 } }],
    gamePlayers: [{ game_id: 'g_existing', person_id: 'p_existing', seat_order: 0 }],
    rounds: [{ id: 'r_existing', game_id: 'g_existing', round_index: 0, entries: { p_existing: { score: 10 } } }],
  }

  const filtered = filterRowsAlreadyInCloud(localRows, cloudRows)

  assert.deepEqual(filtered.people.map(({ id }) => id), ['p_new'])
  assert.deepEqual(filtered.games.map(({ id }) => id), ['g_new'])
  assert.deepEqual(filtered.gamePlayers.map(({ game_id, person_id }) => [game_id, person_id]), [['g_new', 'p_new']])
  assert.deepEqual(filtered.rounds.map(({ id }) => id), ['r_new'])
})

test('migration reconciliation gives cloud authority to same IDs while retaining local-only records', () => {
  const local = {
    activeGameId: 'g_shared',
    roster: [
      { id: 'p_shared', name: 'Local stale name' },
      { id: 'p_local', name: 'Local-only person' },
    ],
    games: [{
      id: 'g_shared',
      gameId: 'farkle',
      settings: { target: 100 },
      players: [{ id: 'p_shared', name: 'Local stale name' }],
      rounds: [{ id: 'r_shared', entries: { p_shared: { score: 10 } } }],
      finishedAt: null,
    }],
  }
  const cloud = {
    activeGameId: null,
    roster: [{ id: 'p_shared', name: 'Cloud authoritative name' }],
    games: [{
      id: 'g_shared',
      gameId: 'farkle',
      settings: { target: 500 },
      players: [{ id: 'p_shared', name: 'Cloud authoritative name' }],
      rounds: [{ id: 'r_shared', entries: { p_shared: { score: 900 } } }],
      finishedAt: 123,
    }],
  }

  const merged = mergeMigrationState(local, cloud)

  assert.equal(merged.roster.find(({ id }) => id === 'p_shared').name, 'Cloud authoritative name')
  assert.equal(merged.roster.some(({ id }) => id === 'p_local'), true)
  assert.equal(merged.games[0].settings.target, 500)
  assert.equal(merged.games[0].rounds[0].entries.p_shared.score, 900)
})

test('fromRemoteRows ignores malformed records, logs a diagnostic, and keeps valid records', () => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (...args) => warnings.push(args.join(' '))
  try {
    const state = fromRemoteRows({
      people: [
        { id: 'p_valid', name: 'Valid' },
        { id: 'p_bad', name: null },
      ],
      games: [
        { id: 'g_valid', game_id: 'farkle', settings: { target: 100 } },
        { id: 'g_unknown', game_id: 'future-game', settings: {} },
        { id: 'g_bad_settings', game_id: 'farkle', settings: { target: '100' } },
      ],
      gamePlayers: [
        { game_id: 'g_valid', person_id: 'p_valid', seat_order: 0, name_snapshot: 'Valid' },
        { game_id: 'g_valid', person_id: 'p_bad_player', seat_order: 'first', name_snapshot: 'Bad' },
      ],
      rounds: [
        { id: 'r_valid', game_id: 'g_valid', round_index: 0, entries: {} },
        { id: 'r_bad', game_id: 'g_valid', round_index: 1, entries: null },
      ],
    })

    assert.deepEqual(state.roster.map(({ id }) => id), ['p_valid'])
    assert.deepEqual(state.games.map(({ id }) => id), ['g_valid'])
    assert.deepEqual(state.games[0].players.map(({ id }) => id), ['p_valid'])
    assert.deepEqual(state.games[0].rounds.map(({ id }) => id), ['r_valid'])
    assert.ok(warnings.some((message) => /malformed remote/i.test(message)))
  } finally {
    console.warn = originalWarn
  }
})

test('fromRemoteRows quarantines remote names outside the database constraint', () => {
  const invalidNames = ['', '   ', 'x'.repeat(81)]
  const paddedValid = `  ${'x'.repeat(80)}  `
  const people = [
    { id: 'p_valid', name: 'Valid Person' },
    { id: 'p_padded_valid', name: paddedValid },
    { id: 'p_deleted', name: 'Deleted Person', deleted_at: '2026-01-01T00:00:00.000Z' },
    { id: 'p_missing_tombstone', deleted_at: '2026-01-01T00:00:00.000Z' },
    ...invalidNames.map((name, index) => ({ id: `p_bad_${index}`, name })),
  ]
  const gamePlayers = [
    { game_id: 'g_valid', person_id: 'p_valid', seat_order: 0, name_snapshot: 'Valid Snapshot' },
    { game_id: 'g_valid', person_id: 'p_padded_valid', seat_order: 1, name_snapshot: paddedValid },
    { game_id: 'g_valid', person_id: 'p_deleted', seat_order: 2, name_snapshot: 'Deleted Snapshot', deleted_at: '2026-01-01T00:00:00.000Z' },
    { game_id: 'g_valid', person_id: 'p_missing_snapshot', seat_order: 3 },
    ...invalidNames.map((name, index) => ({
      game_id: 'g_valid', person_id: `p_bad_${index}`, seat_order: index + 4, name_snapshot: name,
    })),
  ]

  const state = fromRemoteRows({
    people,
    games: [{ id: 'g_valid', game_id: 'farkle', settings: {} }],
    gamePlayers,
    rounds: [],
  })

  assert.deepEqual(state.roster, [
    { id: 'p_valid', name: 'Valid Person' },
    { id: 'p_padded_valid', name: paddedValid },
  ])
  assert.deepEqual(state.games[0].players, [
    { id: 'p_valid', name: 'Valid Person' },
    { id: 'p_padded_valid', name: paddedValid },
  ])
  assert.deepEqual(toRemoteRows(state).people.map(({ id, name, deleted_at }) => ({ id, name, deleted_at })), [
    { id: 'p_valid', name: 'Valid Person', deleted_at: null },
    { id: 'p_padded_valid', name: paddedValid, deleted_at: null },
    { id: 'p_deleted', name: 'Deleted Person', deleted_at: '2026-01-01T00:00:00.000Z' },
  ])
  assert.deepEqual(toRemoteRows(state).gamePlayers.map(({ person_id, name_snapshot, deleted_at }) => ({ person_id, name_snapshot, deleted_at })), [
    { person_id: 'p_valid', name_snapshot: 'Valid Snapshot', deleted_at: null },
    { person_id: 'p_padded_valid', name_snapshot: paddedValid, deleted_at: null },
    { person_id: 'p_deleted', name_snapshot: 'Deleted Snapshot', deleted_at: '2026-01-01T00:00:00.000Z' },
  ])
})

test('fromRemoteRows quarantines malformed nested round entries without losing valid games', () => {
  const state = fromRemoteRows({
    people: [
      { id: 'p_bad', name: 'Bad' },
      { id: 'p_good', name: 'Good' },
    ],
    games: [
      { id: 'g_bad', game_id: 'dutch-blitz', settings: { target: 10, blitzPenalty: 2 } },
      { id: 'g_good', game_id: 'dutch-blitz', settings: { target: 10, blitzPenalty: 2 } },
    ],
    gamePlayers: [
      { game_id: 'g_bad', person_id: 'p_bad', seat_order: 0, name_snapshot: 'Bad' },
      { game_id: 'g_good', person_id: 'p_good', seat_order: 0, name_snapshot: 'Good' },
    ],
    rounds: [
      { id: 'r_bad', game_id: 'g_bad', round_index: 0, entries: { p_bad: null } },
      { id: 'r_good', game_id: 'g_good', round_index: 0, entries: { p_good: { dutch: 10, blitz: 0, blitzed: false } } },
    ],
  })

  assert.deepEqual(state.games.map(({ id }) => id), ['g_bad', 'g_good'])
  assert.deepEqual(state.games.find(({ id }) => id === 'g_bad').rounds, [])
  assert.equal(state.games.find(({ id }) => id === 'g_good').rounds[0].entries.p_good.dutch, 10)
})

test('delta rows exclude unchanged local history from later normal mutations', () => {
  const oldGame = {
    id: 'g_local_only', gameId: 'farkle', createdAt: 100, updatedAt: 100,
    players: [{ id: 'p_old', name: 'Old Player' }], settings: {}, rounds: [], finishedAt: null,
  }
  const newGame = {
    id: 'g_new', gameId: 'farkle', createdAt: 200, updatedAt: 200,
    players: [{ id: 'p_old', name: 'Old Player' }], settings: {}, rounds: [], finishedAt: null,
  }
  const previous = { roster: [{ id: 'p_old', name: 'Old Player' }], games: [oldGame] }
  const next = { roster: previous.roster, games: [oldGame, newGame] }

  const rows = toRemoteRowsDelta(next, previous)
  assert.deepEqual(rows.games.map((game) => game.id), ['g_new'])
  assert.deepEqual(rows.gamePlayers.map((player) => player.game_id), ['g_new'])
})

test('scoped deltas preserve original round and player positions', () => {
  const previousGame = {
    id: 'g_positions',
    gameId: 'farkle',
    createdAt: 1,
    updatedAt: 100,
    players: [
      { id: 'p_one', name: 'One' },
      { id: 'p_two', name: 'Two' },
      { id: 'p_three', name: 'Three' },
    ],
    settings: {},
    rounds: [
      { id: 'r_one', entries: {} },
      { id: 'r_two', entries: { p_one: { score: 2 } } },
      { id: 'r_three', entries: {} },
    ],
    finishedAt: null,
  }
  const nextGame = {
    ...previousGame,
    rounds: [
      previousGame.rounds[0],
      { ...previousGame.rounds[1], entries: { p_one: { score: 22 } } },
      previousGame.rounds[2],
    ],
    players: [
      previousGame.players[0],
      previousGame.players[1],
      { ...previousGame.players[2], name: 'Three Updated' },
    ],
  }

  const rows = toRemoteRowsDelta(
    { roster: [], games: [nextGame] },
    { roster: [], games: [previousGame] },
    { gameId: 'g_positions', includeGame: false, roundIds: ['r_two'], playerIds: ['p_three'] },
  )

  assert.deepEqual(rows.rounds.map(({ id, round_index }) => [id, round_index]), [['r_two', 1]])
  assert.deepEqual(rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]), [['p_three', 2]])
})

test('scoped deltas preserve shifted positions after removing earlier children', () => {
  const previousGame = {
    id: 'g_shifted_positions',
    gameId: 'farkle',
    createdAt: 1,
    updatedAt: 100,
    players: [
      { id: 'p_one', name: 'One' },
      { id: 'p_two', name: 'Two' },
      { id: 'p_three', name: 'Three' },
    ],
    settings: {},
    rounds: [
      { id: 'r_one', entries: {} },
      { id: 'r_two', entries: {} },
      { id: 'r_three', entries: {} },
    ],
    finishedAt: null,
  }
  const nextGame = {
    ...previousGame,
    players: [previousGame.players[0], previousGame.players[2]],
    rounds: [previousGame.rounds[0], previousGame.rounds[2]],
  }

  const rows = toRemoteRowsDelta(
    { roster: [], games: [nextGame] },
    { roster: [], games: [previousGame] },
    { gameId: 'g_shifted_positions', includeGame: false, roundIds: ['r_three'], playerIds: ['p_three'] },
  )

  assert.deepEqual(rows.rounds.map(({ id, round_index }) => [id, round_index]), [['r_three', 1]])
  assert.deepEqual(rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]), [['p_three', 1]])
})

test('full export recomputes positions after deleting earlier synced children', () => {
  const source = {
    activeGameId: 'g_synced_positions',
    roster: [
      { id: 'p_one', name: 'One' },
      { id: 'p_two', name: 'Two' },
      { id: 'p_three', name: 'Three' },
    ],
    games: [{
      id: 'g_synced_positions',
      gameId: 'farkle',
      createdAt: 1,
      updatedAt: 1000,
      players: [
        { id: 'p_one', name: 'One', updatedAt: 1100 },
        { id: 'p_two', name: 'Two', updatedAt: 1200 },
        { id: 'p_three', name: 'Three', updatedAt: 1300 },
      ],
      settings: {},
      rounds: [
        { id: 'r_one', updatedAt: 1400, entries: {} },
        { id: 'r_two', updatedAt: 1500, entries: {} },
        { id: 'r_three', updatedAt: 1600, entries: {} },
      ],
      finishedAt: null,
    }],
  }
  const synced = fromRemoteRows(toRemoteRows(source), source.activeGameId)
  const shifted = {
    ...synced,
    games: [{
      ...synced.games[0],
      players: synced.games[0].players.slice(1),
      rounds: synced.games[0].rounds.slice(1),
    }],
  }

  const rows = toRemoteRows(shifted)

  assert.deepEqual(rows.rounds.map(({ id, round_index }) => [id, round_index]), [['r_two', 0], ['r_three', 1]])
  assert.deepEqual(rows.gamePlayers.map(({ person_id, seat_order }) => [person_id, seat_order]), [['p_two', 0], ['p_three', 1]])
})

test('reconstructs nested state, resolves names, converts timestamps, and filters tombstones', () => {
  const state = fromRemoteRows({
    people: [
      { id: 'p_live', name: 'Current Name', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z', deleted_at: null },
      { id: 'p_archived', name: 'Archived Name', deleted_at: '2024-01-03T00:00:00.000Z' },
    ],
    games: [
      {
        id: 'g_live', game_id: 'farkle', created_at: '2024-01-01T00:00:00.000Z',
        updated_at: '2024-01-04T00:00:00.000Z', finished_at: '2024-01-05T00:00:00.000Z',
        settings: { target: 10000 }, deleted_at: null,
      },
      { id: 'g_deleted', game_id: 'farkle', created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-02T00:00:00.000Z', deleted_at: '2024-01-03T00:00:00.000Z' },
    ],
    gamePlayers: [
      { game_id: 'g_live', person_id: 'p_live', seat_order: 0, name_snapshot: 'Old Name', updated_at: '2024-01-04T00:00:00.000Z', deleted_at: null },
      { game_id: 'g_live', person_id: 'p_missing', seat_order: 1, name_snapshot: 'Snapshot Name', updated_at: '2024-01-04T00:00:00.000Z', deleted_at: null },
      { game_id: 'g_live', person_id: 'p_archived', seat_order: 2, name_snapshot: 'Archived Snapshot', updated_at: '2024-01-04T00:00:00.000Z', deleted_at: null },
      { game_id: 'g_live', person_id: 'p_deleted', seat_order: 3, name_snapshot: 'Deleted Player', updated_at: '2024-01-04T00:00:00.000Z', deleted_at: '2024-01-05T00:00:00.000Z' },
      { game_id: 'g_deleted', person_id: 'p_live', seat_order: 0, name_snapshot: 'Hidden Game Player', updated_at: '2024-01-02T00:00:00.000Z', deleted_at: null },
    ],
    rounds: [
      { id: 'r_live', game_id: 'g_live', round_index: 0, entries: { p_live: { score: 500 } }, updated_at: '2024-01-04T00:00:00.000Z', deleted_at: null },
      { id: 'r_deleted', game_id: 'g_live', round_index: 1, entries: {}, updated_at: '2024-01-05T00:00:00.000Z', deleted_at: '2024-01-06T00:00:00.000Z' },
      { id: 'r_hidden_game', game_id: 'g_deleted', round_index: 0, entries: {}, updated_at: '2024-01-02T00:00:00.000Z', deleted_at: null },
    ],
  }, 'g_local')

  assert.deepEqual(state, {
    activeGameId: 'g_local',
    roster: [{ id: 'p_live', name: 'Current Name' }],
    games: [{
      id: 'g_live',
      gameId: 'farkle',
      createdAt: 1704067200000,
      updatedAt: 1704326400000,
      players: [
        { id: 'p_live', name: 'Current Name' },
        { id: 'p_missing', name: 'Snapshot Name' },
        { id: 'p_archived', name: 'Archived Snapshot' },
      ],
      settings: { target: 10000 },
      rounds: [{ id: 'r_live', entries: { p_live: { score: 500 } } }],
      finishedAt: 1704412800000,
    }],
  })
})

test('round-trips deleted round metadata after the visible round is removed', () => {
  const sourceRows = {
    people: [],
    games: [{
      id: 'g_round', game_id: 'farkle', updated_at: '2026-01-03T00:00:00.000Z', settings: {},
    }],
    gamePlayers: [],
    rounds: [{
      id: 'r_removed', game_id: 'g_round', round_index: 4,
      entries: { p_one: { score: 42 } },
      updated_at: '2026-01-03T00:00:01.000Z', deleted_at: '2026-01-03T00:00:02.000Z',
    }],
  }

  const state = fromRemoteRows(sourceRows)
  const rows = toRemoteRows(state)
  assert.deepEqual(rows.rounds, [sourceRows.rounds[0]])
  assert.deepEqual(toRemoteRows(fromRemoteRows(rows)).rounds, [sourceRows.rounds[0]])
})

test('round-trips metadata-only person and game tombstones without duplicating live rows', () => {
  const sourceRows = {
    people: [
      {
        id: 'p_live', name: 'Live', normalized_name: 'live',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null,
      },
      {
        id: 'p_deleted', name: 'Deleted', normalized_name: 'deleted',
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
        deleted_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    games: [
      {
        id: 'g_live', game_id: 'farkle', created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z', finished_at: null, settings: { target: 100 }, deleted_at: null,
      },
      {
        id: 'g_deleted', game_id: 'dutch-blitz', created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-03T00:00:00.000Z', finished_at: '2026-01-03T00:00:01.000Z',
        settings: { target: 50 }, deleted_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    gamePlayers: [],
    rounds: [],
  }

  const rows = toRemoteRows(fromRemoteRows(sourceRows))

  assert.deepEqual(rows.people, sourceRows.people)
  assert.deepEqual(rows.games, sourceRows.games)
  assert.equal(rows.people.filter((person) => person.id === 'p_live').length, 1)
  assert.equal(rows.people.filter((person) => person.id === 'p_deleted').length, 1)
  assert.equal(rows.games.filter((game) => game.id === 'g_live').length, 1)
  assert.equal(rows.games.filter((game) => game.id === 'g_deleted').length, 1)
  assert.deepEqual(toRemoteRows(fromRemoteRows(rows)).people, sourceRows.people)
  assert.deepEqual(toRemoteRows(fromRemoteRows(rows)).games, sourceRows.games)
})

test('preserves a reconstructed person created_at through local deletion tombstone round-trip', () => {
  const deletedAt = '2026-01-04T00:00:00.000Z'
  const state = fromRemoteRows({
    people: [{
      id: 'p_removed', name: 'Removed', normalized_name: 'removed',
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z', deleted_at: null,
    }],
    games: [], gamePlayers: [], rounds: [],
  })

  const deleted = applyCloudSoftDelete(state, 'people', 'p_removed', deletedAt)
  const expected = {
    id: 'p_removed', name: 'Removed', normalized_name: 'removed',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: deletedAt, deleted_at: deletedAt,
  }

  assert.deepEqual(toRemoteRows(deleted).people, [expected])
  assert.deepEqual(toRemoteRows(fromRemoteRows(toRemoteRows(deleted))).people, [expected])
})

test('uses the deleted person snapshot when the live roster row was already filtered', () => {
  const deletedAt = '2026-01-04T00:00:00.000Z'
  const deleted = applyCloudSoftDelete(
    { roster: [], games: [], activeGameId: null },
    'people',
    'p_removed',
    deletedAt,
    {
      person: {
        id: 'p_removed',
        name: 'Removed Person',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    },
  )

  assert.deepEqual(toRemoteRows(deleted).people, [{
    id: 'p_removed',
    name: 'Removed Person',
    normalized_name: 'removed person',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: deletedAt,
    deleted_at: deletedAt,
  }])
})

test('emits preserved local round data when recording a parent-keyed tombstone', () => {
  const deletedAt = '2026-01-03T00:00:02.000Z'
  const cache = {
    activeGameId: 'g_round',
    roster: [],
    games: [{
      id: 'g_round', gameId: 'farkle', players: [], settings: {}, rounds: [{
        id: 'r_removed', roundIndex: 4, entries: { p_one: { score: 42 } },
      }],
    }],
  }

  assert.deepEqual(toRemoteRows(applyCloudSoftDelete(
    cache, 'rounds', { gameId: 'g_round', id: 'r_removed' }, deletedAt,
  )).rounds, [{
    id: 'r_removed', game_id: 'g_round', round_index: 4, entries: { p_one: { score: 42 } },
    updated_at: deletedAt, deleted_at: deletedAt,
  }])
})

test('uses null for missing optional remote timestamps', () => {
  const state = fromRemoteRows({
    people: [{ id: 'p_one', name: 'One' }],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z', settings: {} }],
    gamePlayers: [],
    rounds: [],
  })

  assert.equal(state.games[0].finishedAt, null)
})

test('handles malformed and out-of-range timestamps without throwing', () => {
  assert.doesNotThrow(() => {
    const rows = toRemoteRows({
      roster: [],
      games: [{
        id: 'g_invalid',
        gameId: 'farkle',
        createdAt: Number.MAX_VALUE,
        updatedAt: Number.MAX_VALUE,
        finishedAt: Number.MAX_VALUE,
        players: [],
        settings: {},
        rounds: [],
      }],
    })

    assert.equal(rows.games[0].created_at, '1970-01-01T00:00:00.000Z')
    assert.equal(rows.games[0].updated_at, '1970-01-01T00:00:00.000Z')
    assert.equal(rows.games[0].finished_at, null)
  })

  const state = fromRemoteRows({
    people: [],
    games: [{
      id: 'g_invalid', game_id: 'farkle', created_at: 'not-a-timestamp',
      updated_at: Number.MAX_VALUE, finished_at: 'also-invalid', settings: {},
    }],
    gamePlayers: [],
    rounds: [],
  })
  assert.equal(state.games[0].createdAt, null)
  assert.equal(state.games[0].updatedAt, null)
  assert.equal(state.games[0].finishedAt, null)
})

test('copies non-enumerable cloud metadata onto cache-shaped state updates', () => {
  const source = fromRemoteRows({
    people: [{ id: 'p_one', name: 'One' }],
    games: [{ id: 'g_one', game_id: 'farkle', settings: {} }],
    gamePlayers: [{
      game_id: 'g_one', person_id: 'p_removed', seat_order: 0, name_snapshot: 'Removed',
      updated_at: '2026-01-02T00:00:00.000Z', deleted_at: '2026-01-02T00:00:00.000Z',
    }],
    rounds: [],
  })
  const updated = copyCloudMetadata({ ...source, activeGameId: null }, source)

  assert.equal(Object.prototype.propertyIsEnumerable.call(updated, Symbol.for('gamescorer.cloudMetadata')), false)
  assert.equal(toRemoteRows(updated).gamePlayers[0].deleted_at, '2026-01-02T00:00:00.000Z')
})

test('round-trips player versions, player tombstones, and standalone person creation time', () => {
  const state = fromRemoteRows({
    people: [
      { id: 'p_player', name: 'Current', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.200Z' },
      { id: 'p_removed', name: 'Removed', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.300Z' },
      { id: 'p_standalone', name: 'Standalone', created_at: '1970-01-01T00:00:00.400Z', updated_at: '1970-01-01T00:00:00.450Z' },
    ],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:00.500Z', settings: {} }],
    gamePlayers: [
      { game_id: 'g_one', person_id: 'p_player', seat_order: 3, name_snapshot: 'Original', updated_at: '1970-01-01T00:00:00.250Z' },
      { game_id: 'g_one', person_id: 'p_removed', seat_order: 1, name_snapshot: 'Removed Snapshot', updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z' },
    ],
    rounds: [],
  })

  const rows = toRemoteRows(state)
  assert.deepEqual(rows.people.find((person) => person.id === 'p_standalone'), {
    id: 'p_standalone',
    name: 'Standalone',
    normalized_name: 'standalone',
    created_at: '1970-01-01T00:00:00.400Z',
    updated_at: '1970-01-01T00:00:00.450Z',
    deleted_at: null,
  })
  assert.deepEqual(rows.gamePlayers, [
    {
      game_id: 'g_one', person_id: 'p_player', seat_order: 0, name_snapshot: 'Original',
      updated_at: '1970-01-01T00:00:00.250Z', deleted_at: null,
    },
    {
      game_id: 'g_one', person_id: 'p_removed', seat_order: 1, name_snapshot: 'Removed Snapshot',
      updated_at: '1970-01-01T00:00:00.300Z', deleted_at: '1970-01-01T00:00:00.300Z',
    },
  ])
})

test('selects player tombstones by the maximum updated or deleted timestamp', () => {
  const state = fromRemoteRows({
    people: [{ id: 'p_player', name: 'Current' }],
    games: [{ id: 'g_one', game_id: 'farkle', created_at: '1970-01-01T00:00:00.100Z', updated_at: '1970-01-01T00:00:01.000Z', settings: {} }],
    gamePlayers: [
      { game_id: 'g_one', person_id: 'p_player', seat_order: 2, name_snapshot: 'Live', updated_at: '1970-01-01T00:00:00.850Z' },
      { game_id: 'g_one', person_id: 'p_player', seat_order: 4, name_snapshot: 'Newest Update', updated_at: '1970-01-01T00:00:00.900Z', deleted_at: '1970-01-01T00:00:00.100Z' },
      { game_id: 'g_one', person_id: 'p_player', seat_order: 1, name_snapshot: 'Stale Tombstone', updated_at: '1970-01-01T00:00:00.200Z', deleted_at: '1970-01-01T00:00:00.800Z' },
    ],
    rounds: [],
  })

  assert.deepEqual(toRemoteRows(state).gamePlayers, [{
    game_id: 'g_one', person_id: 'p_player', seat_order: 4, name_snapshot: 'Newest Update',
    updated_at: '1970-01-01T00:00:00.900Z', deleted_at: '1970-01-01T00:00:00.100Z',
  }])
})

test('keeps roster tombstones authoritative over newer historical player candidates', () => {
  const state = fromRemoteRows({
    people: [
      {
        id: 'p_archived',
        name: 'Archived Person',
        updated_at: '2026-01-01T00:00:00.000Z',
        deleted_at: '2026-01-01T00:00:01.000Z',
      },
      { id: 'p_active', name: 'Active Person', updated_at: '2026-01-02T00:00:00.000Z' },
    ],
    games: [{ id: 'g_history', game_id: 'farkle', updated_at: '2026-01-04T00:00:00.000Z', settings: {} }],
    gamePlayers: [
      {
        game_id: 'g_history', person_id: 'p_archived', seat_order: 0,
        name_snapshot: 'Historical Snapshot', updated_at: '2026-01-03T00:00:00.000Z',
      },
      {
        game_id: 'g_history', person_id: 'p_active', seat_order: 1,
        name_snapshot: 'Active Snapshot', updated_at: '2026-01-03T00:00:00.000Z',
      },
    ],
    rounds: [],
  })

  const rows = toRemoteRows(state)

  assert.equal(rows.people.find(({ id }) => id === 'p_archived').deleted_at, '2026-01-01T00:00:01.000Z')
  assert.equal(rows.gamePlayers.find(({ person_id }) => person_id === 'p_archived').name_snapshot, 'Historical Snapshot')
  assert.equal(rows.people.find(({ id }) => id === 'p_active').deleted_at, null)
})
