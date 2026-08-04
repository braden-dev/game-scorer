import { useCallback, useEffect, useRef, useState } from 'react'
import { hasStateData, loadReconciledState, loadState, saveState, saveStateToCloudCache } from './lib/storage.js'
import { uid } from './lib/util.js'
import { GAMES_BY_ID, getGameDef, evaluate, migrateState } from './games/index.js'
import { useInstallPrompt } from './lib/useInstallPrompt.js'
import { cloudConfigured } from './lib/supabase.js'
import { clone, loadSyncStore } from './lib/sync.js'
import { filterRowsAlreadyInCloud, findCloudTombstone, mergeMigrationState, stampMigrationRows, toRemoteRows, toRemoteRowsDelta } from './lib/cloudState.js'
import { useCloudSync } from './lib/useCloudSync.js'
import { navigate, readRoute, subscribeToRoutes } from './lib/router.js'
import Home from './components/Home.jsx'
import NewGame from './components/NewGame.jsx'
import GameView from './components/GameView.jsx'
import People from './components/People.jsx'
import PersonPage from './components/PersonPage.jsx'
import Games from './components/Games.jsx'
import Leaderboard from './components/Leaderboard.jsx'
import DataPanel from './components/DataPanel.jsx'
import InstallBanner from './components/InstallBanner.jsx'
import UndoToast from './components/UndoToast.jsx'

const UNDO_WINDOW_MS = 10_000

function snapshot(value) {
  return clone(value)
}

function comparableRecord(value) {
  if (!value) return null
  const copy = snapshot(value)
  delete copy.updatedAt
  delete copy.updated_at
  return JSON.stringify(copy)
}

function changedRecordIds(previousRecords = [], nextRecords = [], includePosition = false) {
  const previousById = new Map(previousRecords.map((record, index) => [record.id, { record, index }]))
  return nextRecords
    .filter((record, index) => {
      const previousEntry = previousById.get(record.id)
      const previous = previousEntry?.record
      return !previous
        || comparableRecord(previous) !== comparableRecord(record)
        || (includePosition && previousEntry.index !== index)
    })
    .map((record) => record.id)
}

function comparableGameMetadata(value) {
  if (!value) return null
  const copy = snapshot(value)
  delete copy.updatedAt
  delete copy.updated_at
  delete copy.players
  delete copy.rounds
  return JSON.stringify(copy)
}

function revivedGame(game, deletedAt) {
  const updatedAt = Math.max(Date.now(), (Number(deletedAt) || 0) + 1)
  const revived = snapshot(game)
  revived.updatedAt = updatedAt
  return revived
}

function migrationVersion(lastSyncAt) {
  const lastSyncMilliseconds = Date.parse(lastSyncAt ?? '')
  return new Date(Math.max(
    Date.now(),
    Number.isFinite(lastSyncMilliseconds) ? lastSyncMilliseconds + 1 : 0,
  )).toISOString()
}

function hasCompleteReconciledCloudSnapshot(store) {
  const games = store?.reconciledCache?.games
  return Boolean(
    store?.lastSyncAt
      && Array.isArray(games)
      && Array.isArray(store.reconciledCache?.roster)
      && games.every((game) => Array.isArray(game?.players) && Array.isArray(game?.rounds)),
  )
}

function restoreExpectedTombstone(entity, id, parentId, fallbackAt) {
  const store = loadSyncStore()
  const requestedDeletedAt = new Date(fallbackAt).getTime()
  const cachedTombstones = [
    findCloudTombstone(store.cache, entity, id, parentId),
    findCloudTombstone(store.reconciledCache, entity, id, parentId),
  ]
  const tombstone = cachedTombstones.find((candidate) => (
    candidate && new Date(candidate.deletedAt).getTime() === requestedDeletedAt
  ))
  const deletedAt = tombstone?.deletedAt ?? new Date(fallbackAt).toISOString()
  const updatedAt = tombstone?.updatedAt ?? deletedAt
  const identity = entity === 'game_players'
    ? { game_id: parentId, person_id: id }
    : entity === 'rounds'
      ? { id, game_id: parentId }
      : { id }
  return {
    ...identity,
    updated_at: new Date(updatedAt).toISOString(),
    deleted_at: deletedAt,
  }
}

export function AppShell({ content, undoToast }) {
  return <>{content}{undoToast}</>
}

export default function App() {
  const [state, setState] = useState(() => migrateState(loadState()))
  const hadLocalDataAtStartup = useRef(hasStateData(state)).current
  const [newGameId, setNewGameId] = useState(null)
  const [route, setRoute] = useState(() => readRoute())
  const [showData, setShowData] = useState(false)
  const [initialMigrationCompleted, setInitialMigrationCompleted] = useState(
    () => loadSyncStore().initialMigrationCompleted,
  )
  const stateRef = useRef(state)
  const migrationStartedRef = useRef(false)
  const migrationEnqueuedRef = useRef(loadSyncStore().outbox.some((mutation) => mutation.initialMigration))
  const migrationRetryBlockedRef = useRef(null)
  const undoRef = useRef(null)
  const [undoAction, setUndoAction] = useState(null)
  const install = useInstallPrompt()
  const configured = cloudConfigured()
  const sync = useCloudSync(state, setState)

  useEffect(() => subscribeToRoutes((nextRoute) => {
    setRoute(nextRoute)
    if (nextRoute.type !== 'game') {
      setNewGameId(null)
      setState((previous) => previous.activeGameId === null ? previous : { ...previous, activeGameId: null })
    }
  }), [])

  useEffect(() => {
    stateRef.current = state
    saveState(state)
  }, [state])

  const stateChangeMutation = useCallback((nextState, previousState, options) => ({
    id: uid('m'),
    entity: 'scorebook',
    operation: 'upsert',
    payload: { rows: toRemoteRowsDelta(nextState, previousState, options) },
  }), [])

  /**
   * All cloud-visible changes pass through this boundary. Navigation remains
   * a plain local state change below, so a remote response can never reopen a
   * game on the wrong device.
   */
  const applyMutation = useCallback((updater, mutationFactory) => {
    const previous = stateRef.current
    const next = updater(previous)
    stateRef.current = next
    setState(next)
    saveState(next)

    if (configured) {
      saveStateToCloudCache(next)
      const mutationResult = typeof mutationFactory === 'function'
        ? mutationFactory(next, previous)
        : mutationFactory
      const mutations = Array.isArray(mutationResult) ? mutationResult : [mutationResult]
      for (const mutation of mutations) {
        if (mutation) sync.enqueueStateMutation({ ...mutation, state: next })
      }
    }
    return next
  }, [configured, sync])

  const showUndo = useCallback((action) => {
    const next = { ...action, id: uid('undo'), expiresAt: Date.now() + UNDO_WINDOW_MS }
    undoRef.current = next
    setUndoAction(next)
  }, [])

  const expireUndo = useCallback((id) => {
    if (undoRef.current?.id !== id) return
    undoRef.current = null
    setUndoAction(null)
  }, [])

  const undo = useCallback(() => {
    const action = undoRef.current
    if (!action || action.expiresAt <= Date.now()) {
      if (action) expireUndo(action.id)
      return
    }
    undoRef.current = null
    setUndoAction(null)
    const mutationIds = action.mutationIds ?? (action.mutationId ? [action.mutationId] : [])
    if (mutationIds.length) sync.cancelSyncMutations?.((mutation) => mutationIds.includes(mutation.id))

    const restoreExpected = action.kind === 'round'
      ? restoreExpectedTombstone('rounds', action.round.id, action.gameId, action.deletedAt)
      : action.kind === 'player'
        ? restoreExpectedTombstone('game_players', action.player.id, action.gameId, action.deletedAt)
        : restoreExpectedTombstone('games', action.game.id, null, action.deletedAt)
    const restoreMutation = (nextState, previousState, options, entity) => ({
      ...stateChangeMutation(nextState, previousState, options),
      operation: 'restore',
      restore: { [entity]: [restoreExpected] },
    })
    const mutationFactory = action.kind === 'round'
      ? (nextState, previousState) => restoreMutation(nextState, previousState, {
        gameId: action.gameId,
        playerIds: [],
        roundIds: changedRecordIds(
          previousState.games.find((game) => game.id === action.gameId)?.rounds ?? [],
          nextState.games.find((game) => game.id === action.gameId)?.rounds ?? [],
          true,
        ),
      }, 'rounds')
      : action.kind === 'player'
        ? (nextState, previousState) => {
          const previousGame = previousState.games.find((candidate) => candidate.id === action.gameId)
          const nextGame = nextState.games.find((candidate) => candidate.id === action.gameId)
          const includeGame = comparableGameMetadata(previousGame) !== comparableGameMetadata(nextGame)
          return restoreMutation(nextState, previousState, {
            gameId: action.gameId,
            includeGame,
            playerIds: changedRecordIds(previousGame?.players ?? [], nextGame?.players ?? [], true),
            roundIds: changedRecordIds(previousGame?.rounds ?? [], nextGame?.rounds ?? [], true),
          }, 'gamePlayers')
        }
        : (nextState, previousState) => restoreMutation(nextState, previousState, undefined, 'games')
    applyMutation((previous) => {
      if (action.kind === 'game') {
        if (previous.games.some((game) => game.id === action.game.id)) return previous
        const games = previous.games.slice()
        games.splice(Math.min(action.gameIndex, games.length), 0, revivedGame(action.game, action.deletedAt))
        return {
          ...previous,
          games,
          activeGameId: previous.activeGameId === null && action.previousActiveGameId === action.game.id
            ? action.game.id
            : previous.activeGameId,
        }
      }

      const game = previous.games.find((candidate) => candidate.id === action.gameId)
      if (!game) return previous
      if (action.kind === 'player') {
        if (game.players.some((player) => player.id === action.player.id)) return previous
        const restoreAt = Math.max(Date.now(), (Number(action.deletedAt) || 0) + 1)
        const restoredPlayer = snapshot(action.player)
        restoredPlayer.updatedAt = restoreAt
        const players = game.players.slice()
        players.splice(Math.min(action.playerIndex, players.length), 0, restoredPlayer)
        const restoredMetadata = action.gameSnapshot ? snapshot(action.gameSnapshot) : game
        const snapshotRounds = new Map((restoredMetadata.rounds ?? []).map((round) => [round.id, round]))
        const rounds = game.rounds.map((round) => {
          const snapshotRound = snapshotRounds.get(round.id)
          const restoredEntry = snapshotRound?.entries?.[action.player.id]
          if (restoredEntry === undefined) return round
          return {
            ...round,
            entries: { ...round.entries, [action.player.id]: snapshot(restoredEntry) },
            updatedAt: Math.max(restoreAt, (Number(round.updatedAt) || 0) + 1),
          }
        })
        const metadataChanged = comparableGameMetadata(game) !== comparableGameMetadata(restoredMetadata)
        const updatedGame = metadataChanged
          ? revivedGame({ ...restoredMetadata, players, rounds }, action.deletedAt)
          : { ...game, players, rounds }
        return { ...previous, games: previous.games.map((candidate) => candidate.id === game.id ? updatedGame : candidate) }
      }
      if (game.rounds.some((round) => round.id === action.round.id)) return previous
      const rounds = game.rounds.slice()
      const restoredRound = snapshot(action.round)
      restoredRound.updatedAt = Math.max(Date.now(), (Number(action.deletedAt) || 0) + 1)
      rounds.splice(Math.min(action.roundIndex, rounds.length), 0, restoredRound)
      const restoredMetadata = action.gameSnapshot ? snapshot(action.gameSnapshot) : game
      const updatedGame = revivedGame({
        ...restoredMetadata,
        // Keep the current child collections so unrelated edits are not
        // replaced while the deleted round is being restored.
        players: game.players,
        rounds,
      }, action.deletedAt)
      return { ...previous, games: previous.games.map((candidate) => candidate.id === game.id ? updatedGame : candidate) }
    }, mutationFactory)
  }, [applyMutation, expireUndo, stateChangeMutation, sync])

  // A record for a game this build doesn't know about would crash every screen
  // that scores it. That happens for real: an installed PWA can be running a
  // cached older build when a backup from a newer one is imported. Hide those
  // rather than render them — they stay in storage and reappear after an update.
  const playableGames = state.games.filter((g) => !g.deletedAt && !g.deleted_at && getGameDef(g.gameId))
  const routeEnvironment = typeof globalThis.window !== 'undefined' && Boolean(globalThis.window.location)
  const requestedGameId = route.type === 'game' ? route.id : routeEnvironment ? null : state.activeGameId
  const activeGame = playableGames.find((g) => g.id === requestedGameId) || null

  const addToRoster = (name) => {
    const version = Date.parse(migrationVersion(loadSyncStore().lastSyncAt))
    const person = { id: uid('p'), name, createdAt: version, updatedAt: version }
    applyMutation(
      (prev) => ({ ...prev, roster: [...prev.roster, person] }),
      stateChangeMutation,
    )
    return person
  }

  const removeFromRoster = (id) =>
    applyMutation(
      (prev) => ({ ...prev, roster: prev.roster.filter((p) => p.id !== id) }),
      () => ({
        id: uid('m'),
        entity: 'people',
        entityId: id,
        operation: 'softDelete',
        updatedAt: Date.now(),
      }),
    )

  const startGame = (gameId, players, settings) => {
    const game = {
      id: uid('g'),
      gameId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: players.map((p) => ({ id: p.id, name: p.name })),
      settings,
      rounds: [],
      finishedAt: null,
    }
    applyMutation(
      (prev) => ({ ...prev, games: [...prev.games, game], activeGameId: game.id }),
      stateChangeMutation,
    )
    setNewGameId(null)
    navigate({ type: 'game', id: game.id })
  }

  const openGame = (id) => {
    setState((prev) => ({ ...prev, activeGameId: id }))
    navigate({ type: 'game', id })
  }

  const openNewGame = (gameId) => {
    setNewGameId(gameId)
    navigate({ type: 'new-game', gameId })
  }

  const closeGame = () => {
    setState((prev) => ({ ...prev, activeGameId: null }))
    setNewGameId(null)
    navigate({ type: 'home' })
  }

  const updateGame = (updated) => {
    // Re-derive the finished flag so the home screen and banner stay honest
    // when rounds are edited or deleted after the fact.
    const { status } = evaluate(updated)
    const previousGame = stateRef.current.games.find((game) => game.id === updated.id)
    const removedRound = previousGame?.rounds?.find(
      (round) => !updated.rounds.some((candidate) => candidate.id === round.id),
    )
    const removedRoundIndex = removedRound ? previousGame.rounds.indexOf(removedRound) : -1
    const removedRoundMutationId = removedRound ? uid('m') : null
    const roundTimestamp = Date.now()
    const removedPlayers = previousGame?.players?.filter(
      (player) => !updated.players.some((candidate) => candidate.id === player.id),
    ) ?? []
    const removedPlayerMutationIds = new Map(removedPlayers.map((player) => [player.id, uid('m')]))
    let playerRemovalStateMutationId = null
    const playerDeleteTimestamp = removedPlayers.length
      ? Math.max(roundTimestamp, ...removedPlayers.map((player) => (Number(player.updatedAt) || 0) + 1))
      : null
    const candidateFinishedAt = status.finished
      ? (updated.finishedAt || previousGame?.finishedAt || null)
      : null
    const parentMetadataChanged = comparableGameMetadata(previousGame) !== comparableGameMetadata({
      ...updated,
      finishedAt: candidateFinishedAt,
    })
    const includeGame = Boolean(removedRound)
      || parentMetadataChanged
      || (status.finished && !previousGame?.finishedAt)
      || (!status.finished && Boolean(previousGame?.finishedAt))
    const gameTimestamp = includeGame
      ? Math.max(roundTimestamp, (Number(previousGame?.updatedAt) || 0) + 1)
      : previousGame?.updatedAt ?? updated.updatedAt
    const rounds = updated.rounds.map((round, roundIndex) => {
      const previousRoundIndex = previousGame?.rounds?.findIndex((candidate) => candidate.id === round.id) ?? -1
      const previousRound = previousRoundIndex >= 0 ? previousGame.rounds[previousRoundIndex] : null
      if (previousRound
        && previousRoundIndex === roundIndex
        && comparableRecord(previousRound) === comparableRecord(round)) return round
      return {
        ...round,
        updatedAt: Math.max(
          roundTimestamp,
          (Number(previousRound?.updatedAt) || 0) + 1,
          Number(round.updatedAt) || 0,
        ),
      }
    })
    const players = updated.players.map((player, seatOrder) => {
      const previousPlayerIndex = previousGame?.players?.findIndex((candidate) => candidate.id === player.id) ?? -1
      const previousPlayer = previousPlayerIndex >= 0 ? previousGame.players[previousPlayerIndex] : null
      if (previousPlayer
        && previousPlayerIndex === seatOrder
        && comparableRecord(previousPlayer) === comparableRecord(player)) return player
      return {
        ...player,
        updatedAt: Math.max(
          roundTimestamp,
          (Number(previousPlayer?.updatedAt) || 0) + 1,
          Number(player.updatedAt) || 0,
        ),
      }
    })
    const next = {
      ...updated,
      players,
      rounds,
      updatedAt: gameTimestamp,
      finishedAt: status.finished ? (updated.finishedAt || previousGame?.finishedAt || gameTimestamp) : null,
    }
    const changedRoundIds = changedRecordIds(previousGame?.rounds ?? [], next.rounds, true)
    const changedPlayerIds = changedRecordIds(previousGame?.players ?? [], next.players, true)
    applyMutation(
      (prev) => ({
        ...prev,
        games: prev.games.map((g) => (g.id === next.id ? next : g)),
      }),
      (nextState, previousState) => {
        const previousGame = previousState.games.find((game) => game.id === next.id)
        const removedRound = previousGame?.rounds?.find(
          (round) => !next.rounds.some((candidate) => candidate.id === round.id),
        )
        const mutations = []
        if (removedRound) mutations.push({
          id: removedRoundMutationId,
          entity: 'rounds',
          entityId: removedRound.id,
          operation: 'softDelete',
          updatedAt: next.updatedAt,
          payload: {
            gameId: next.id,
            roundIndex: previousGame.rounds.indexOf(removedRound),
            entries: removedRound.entries,
          },
        })
        mutations.push(...removedPlayers.map((player) => ({
          id: removedPlayerMutationIds.get(player.id),
          entity: 'game_players',
          entityId: { gameId: next.id, personId: player.id },
          operation: 'softDelete',
          updatedAt: playerDeleteTimestamp,
          payload: {
            gameId: next.id,
            personId: player.id,
            seatOrder: previousGame.players.indexOf(player),
            nameSnapshot: player.name,
          },
        })))
        const stateMutation = stateChangeMutation(nextState, previousState, {
          gameId: next.id,
          includeGame,
          playerIds: changedPlayerIds,
          roundIds: changedRoundIds,
        })
        if (removedPlayers.length === 1) playerRemovalStateMutationId = stateMutation.id
        mutations.push(stateMutation)
        return mutations.length === 1 ? mutations[0] : mutations
      },
    )
    if (removedRound && previousGame) {
      showUndo({
        kind: 'round',
        gameId: next.id,
        gameSnapshot: snapshot(previousGame),
        round: snapshot(removedRound),
        roundIndex: removedRoundIndex,
        deletedAt: next.updatedAt,
        mutationId: removedRoundMutationId,
      })
    } else if (removedPlayers.length === 1 && previousGame) {
      const removedPlayer = removedPlayers[0]
      showUndo({
        kind: 'player',
        gameId: next.id,
        gameSnapshot: snapshot(previousGame),
        player: snapshot(removedPlayer),
        playerIndex: previousGame.players.indexOf(removedPlayer),
        deletedAt: playerDeleteTimestamp,
        mutationId: removedPlayerMutationIds.get(removedPlayer.id),
        mutationIds: [removedPlayerMutationIds.get(removedPlayer.id), playerRemovalStateMutationId].filter(Boolean),
      })
    }
  }

  const deleteGame = (id) => {
    const game = state.games.find((g) => g.id === id)
    const def = game ? getGameDef(game.gameId) : null
    const label = def ? `this ${def.name} game` : 'this game'
    if (!window.confirm(`Delete ${label}? Undo is available for 10 seconds.`)) return
    const deletedAt = Date.now()
    const mutationId = uid('m')
    const gameIndex = state.games.findIndex((candidate) => candidate.id === id)
    const previousActiveGameId = state.activeGameId
    const gameSnapshot = snapshot(game)
    applyMutation(
      (prev) => ({
        ...prev,
        games: prev.games.filter((g) => g.id !== id),
        activeGameId: prev.activeGameId === id ? null : prev.activeGameId,
      }),
      () => ({
        id: mutationId,
        entity: 'games',
        entityId: id,
        operation: 'softDelete',
        updatedAt: deletedAt,
      }),
    )
    if (game) showUndo({
      kind: 'game',
      game: gameSnapshot,
      gameIndex,
      previousActiveGameId,
      deletedAt,
      mutationId,
    })
  }

  const rematch = () => {
    if (!activeGame) return
    startGame(activeGame.gameId, activeGame.players, { ...activeGame.settings })
  }

  const publishMigration = async () => {
    const migrationStore = loadSyncStore()
    const existingMigration = migrationStore.outbox.find((mutation) => mutation.initialMigration)

    // A first publish reads the complete cloud snapshot first. This keeps the
    // migration additive and prevents local history from competing with rows
    // that were already seeded by another device.
    let initialSyncResult
    try {
      initialSyncResult = await sync.syncNow({ initial: true })
    } catch (error) {
      initialSyncResult = { ok: false, reason: 'error', error }
    }
    const reconciledStore = loadSyncStore()
    if (initialSyncResult?.ok !== true || initialSyncResult?.fullSnapshot !== true) {
      migrationStartedRef.current = false
      migrationRetryBlockedRef.current = initialSyncResult?.reason === 'offline'
        ? 'offline'
        : reconciledStore.lastError || initialSyncResult?.reason || 'error'
      return
    }
    const cloudState = loadReconciledState()
    if (!cloudState) {
      migrationStartedRef.current = false
      migrationRetryBlockedRef.current = 'missing-reconciled-cloud-snapshot'
      return
    }
    const pendingMigration = reconciledStore.outbox.find((mutation) => mutation.initialMigration)
    if (existingMigration && !pendingMigration) {
      sync.updateSyncStore({ initialMigrationCompleted: true })
      setInitialMigrationCompleted(true)
      return
    }
    const migrationId = pendingMigration?.id ?? existingMigration?.id ?? uid('migration')
    if (pendingMigration) sync.cancelSyncMutations?.((mutation) => mutation.initialMigration)
    const reconciledState = mergeMigrationState(stateRef.current, cloudState)
    stateRef.current = reconciledState
    setState(reconciledState)
    saveState(reconciledState)
    saveStateToCloudCache(reconciledState)
    const cloudRows = toRemoteRows(cloudState)
    const syncVersion = migrationVersion(reconciledStore.lastSyncAt)
    applyMutation(
      (prev) => prev,
      (nextState) => ({
        id: migrationId,
        entity: 'scorebook',
        operation: 'upsert',
        initialMigration: true,
        payload: {
          rows: stampMigrationRows(
            filterRowsAlreadyInCloud(toRemoteRows(nextState), cloudRows),
            syncVersion,
          ),
        },
      }),
    )
    migrationEnqueuedRef.current = true
    await sync.syncNow()
    const store = loadSyncStore()
    if (store.outbox.some((mutation) => mutation.id === migrationId)) {
      throw new Error(store.lastError || 'Could not publish local history yet.')
    }

    sync.updateSyncStore({ initialMigrationCompleted: true })
    setInitialMigrationCompleted(true)
  }

  useEffect(() => {
    if (!migrationEnqueuedRef.current || initialMigrationCompleted) return
    const store = loadSyncStore()
    if (store.outbox.some((mutation) => mutation.initialMigration)) return
    sync.updateSyncStore({ initialMigrationCompleted: true })
    setInitialMigrationCompleted(true)
  }, [initialMigrationCompleted, sync.pendingCount, sync.updateSyncStore])

  useEffect(() => {
    const store = loadSyncStore()
    if (!configured || !hadLocalDataAtStartup || store.initialMigrationCompleted || migrationStartedRef.current) return
    const retryBlock = migrationRetryBlockedRef.current
    const retryState = sync.status === 'offline'
      ? 'offline'
      : sync.status === 'error'
        ? store.lastError || 'error'
        : store.lastError || (!hasCompleteReconciledCloudSnapshot(store) ? 'missing-reconciled-cloud-snapshot' : null)
    if (retryBlock && retryBlock === retryState) return
    migrationRetryBlockedRef.current = null
    migrationStartedRef.current = true
    void publishMigration().catch(() => {})
  }, [configured, hadLocalDataAtStartup, sync.status, publishMigration])

  const getReconciledCloudState = () => loadReconciledState()

  const undoToast = undoAction && (
    <UndoToast
      key={undoAction.id}
      message={`${undoAction.kind === 'game'
        ? 'Game deleted.'
        : undoAction.kind === 'player' ? 'Player removed.' : 'Round deleted.'} Undo is available for 10 seconds.`}
      onUndo={undo}
      onExpire={() => expireUndo(undoAction.id)}
    />
  )

  const requestedNewGameId = route.type === 'new-game' ? route.gameId : newGameId
  const currentNewGameId = typeof requestedNewGameId === 'string' && Object.hasOwn(GAMES_BY_ID, requestedNewGameId)
    ? requestedNewGameId
    : null

  let content
  if (currentNewGameId) {
    content = (
      <NewGame
        gameId={currentNewGameId}
        roster={state.roster}
        onCancel={() => { setNewGameId(null); navigate({ type: 'home' }) }}
        onStart={(players, settings) => startGame(currentNewGameId, players, settings)}
        onAddToRoster={addToRoster}
        onRemoveFromRoster={removeFromRoster}
      />
    )
  } else if (activeGame) {
    content = (
      <GameView
        game={activeGame}
        roster={state.roster}
        onUpdate={updateGame}
        onBack={closeGame}
        onRematch={rematch}
        onAddToRoster={addToRoster}
      />
    )
  } else if (route.type === 'people') {
    content = <People roster={state.roster} games={playableGames} onNavigate={navigate} />
  } else if (route.type === 'person') {
    content = <PersonPage personId={route.id} roster={state.roster} games={playableGames} onNavigate={navigate} />
  } else if (route.type === 'leaderboard') {
    content = <Leaderboard roster={state.roster} games={playableGames} onNavigate={navigate} />
  } else if (route.type === 'games') {
    content = <Games games={playableGames} onNavigate={navigate} />
  } else {
    content = (
      <>
        <Home
          games={playableGames}
          onNew={openNewGame}
          onOpen={openGame}
          onDelete={deleteGame}
          onOpenData={() => setShowData(true)}
          installBanner={<InstallBanner install={install} />}
          onNavigate={navigate}
        />
        {showData && (
          <DataPanel
            state={state}
            install={install}
            sync={configured ? sync : null}
            getReconciledCloudState={configured ? getReconciledCloudState : null}
            onImport={(imported) => applyMutation(
              () => migrateState(imported),
              (nextState, previousState) => ({
                ...stateChangeMutation(nextState, previousState),
                payload: {
                  rows: stampMigrationRows(
                    toRemoteRowsDelta(nextState, previousState),
                    migrationVersion(loadSyncStore().lastSyncAt),
                  ),
                },
              }),
            )}
            onClose={() => setShowData(false)}
          />
        )}
      </>
    )
  }

  return <AppShell content={content} undoToast={undoToast} />
}
