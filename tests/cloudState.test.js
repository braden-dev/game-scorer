import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCloudSoftDelete, copyCloudMetadata, fromRemoteRows, normalizeName, toRemoteRows, toRemoteRowsDelta } from '../src/lib/cloudState.js'

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
        id: 'g_deleted', game_id: 'yahtzee', created_at: '2026-01-01T00:00:00.000Z',
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
      game_id: 'g_one', person_id: 'p_player', seat_order: 3, name_snapshot: 'Original',
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
