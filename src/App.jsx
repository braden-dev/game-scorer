import { useCallback, useEffect, useRef, useState } from 'react'
import { hasStateData, loadReconciledState, loadState, saveState, saveStateToCloudCache, shouldOfferInitialMigration } from './lib/storage.js'
import { uid } from './lib/util.js'
import { GAMES_BY_ID, getGameDef, evaluate, migrateState } from './games/index.js'
import { useInstallPrompt } from './lib/useInstallPrompt.js'
import { cloudConfigured } from './lib/supabase.js'
import { loadSyncStore } from './lib/sync.js'
import { toRemoteRows, toRemoteRowsDelta } from './lib/cloudState.js'
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
import MigrationPanel from './components/MigrationPanel.jsx'

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

  const stateChangeMutation = useCallback((nextState, previousState) => ({
    id: uid('m'),
    entity: 'scorebook',
    operation: 'upsert',
    payload: { rows: toRemoteRowsDelta(nextState, previousState) },
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

  // A record for a game this build doesn't know about would crash every screen
  // that scores it. That happens for real: an installed PWA can be running a
  // cached older build when a backup from a newer one is imported. Hide those
  // rather than render them — they stay in storage and reappear after an update.
  const playableGames = state.games.filter((g) => !g.deletedAt && !g.deleted_at && getGameDef(g.gameId))
  const routeEnvironment = typeof globalThis.window !== 'undefined' && Boolean(globalThis.window.location)
  const requestedGameId = route.type === 'game' ? route.id : routeEnvironment ? null : state.activeGameId
  const activeGame = playableGames.find((g) => g.id === requestedGameId) || null

  const addToRoster = (name) => {
    const person = { id: uid('p'), name }
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
    const next = {
      ...updated,
      updatedAt: Date.now(),
      finishedAt: status.finished ? (updated.finishedAt || Date.now()) : null,
    }
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
        const removedPlayers = previousGame?.players?.filter(
          (player) => !next.players.some((candidate) => candidate.id === player.id),
        ) ?? []
        const mutations = [stateChangeMutation(nextState, previousState)]
        if (removedRound) mutations.push({
          id: uid('m'),
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
          id: uid('m'),
          entity: 'game_players',
          entityId: { gameId: next.id, personId: player.id },
          operation: 'softDelete',
          updatedAt: next.updatedAt,
          payload: {
            gameId: next.id,
            personId: player.id,
            seatOrder: previousGame.players.indexOf(player),
            nameSnapshot: player.name,
          },
        })))
        return mutations.length === 1 ? mutations[0] : mutations
      },
    )
  }

  const deleteGame = (id) => {
    const game = state.games.find((g) => g.id === id)
    const def = game ? getGameDef(game.gameId) : null
    const label = def ? `this ${def.name} game` : 'this game'
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return
    applyMutation(
      (prev) => ({
        ...prev,
        games: prev.games.filter((g) => g.id !== id),
        activeGameId: prev.activeGameId === id ? null : prev.activeGameId,
      }),
      () => ({
        id: uid('m'),
        entity: 'games',
        entityId: id,
        operation: 'softDelete',
        updatedAt: Date.now(),
      }),
    )
  }

  const rematch = () => {
    if (!activeGame) return
    startGame(activeGame.gameId, activeGame.players, { ...activeGame.settings })
  }

  const keepLocalForNow = () => {
    sync.cancelSyncMutations((mutation) => mutation.initialMigration)
    sync.updateSyncStore({ initialMigrationCompleted: true })
    setInitialMigrationCompleted(true)
  }

  const publishMigration = async () => {
    const existingMigration = loadSyncStore().outbox.find((mutation) => mutation.initialMigration)
    const migrationId = existingMigration?.id ?? uid('migration')
    if (!existingMigration) {
      applyMutation(
        (prev) => prev,
        (nextState) => ({
          id: migrationId,
          entity: 'scorebook',
          operation: 'upsert',
          initialMigration: true,
          payload: { rows: toRemoteRows(nextState) },
        }),
      )
    }
    await sync.syncNow()
    const store = loadSyncStore()
    if (store.outbox.some((mutation) => mutation.id === migrationId)) {
      throw new Error(store.lastError || 'Could not publish local history yet.')
    }

    sync.updateSyncStore({ initialMigrationCompleted: true })
    setInitialMigrationCompleted(true)
  }

  const getReconciledCloudState = () => loadReconciledState()

  const migrationVisible = shouldOfferInitialMigration({
    configured,
    hadLocalDataAtStartup,
    initialMigrationCompleted,
  })

  const requestedNewGameId = route.type === 'new-game' ? route.gameId : newGameId
  const currentNewGameId = typeof requestedNewGameId === 'string' && Object.hasOwn(GAMES_BY_ID, requestedNewGameId)
    ? requestedNewGameId
    : null

  if (currentNewGameId) {
    return (
      <NewGame
        gameId={currentNewGameId}
        roster={state.roster}
        onCancel={() => { setNewGameId(null); navigate({ type: 'home' }) }}
        onStart={(players, settings) => startGame(currentNewGameId, players, settings)}
        onAddToRoster={addToRoster}
        onRemoveFromRoster={removeFromRoster}
      />
    )
  }

  if (activeGame) {
    return (
      <GameView
        game={activeGame}
        roster={state.roster}
        onUpdate={updateGame}
        onBack={closeGame}
        onRematch={rematch}
        onAddToRoster={addToRoster}
      />
    )
  }

  if (route.type === 'people') {
    return <People roster={state.roster} games={playableGames} onNavigate={navigate} />
  }

  if (route.type === 'person') {
    return <PersonPage personId={route.id} roster={state.roster} games={playableGames} onNavigate={navigate} />
  }

  if (route.type === 'leaderboard') {
    return <Leaderboard roster={state.roster} games={playableGames} onNavigate={navigate} />
  }

  if (route.type === 'games') {
    return <Games games={playableGames} onNavigate={navigate} />
  }

  return (
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
          migrationPending={migrationVisible}
          onPublishMigration={publishMigration}
          onImport={(imported) => applyMutation(
            () => migrateState(imported),
            stateChangeMutation,
          )}
          onClose={() => setShowData(false)}
        />
      )}
      {migrationVisible && (
        <MigrationPanel
          state={state}
          onPublish={publishMigration}
          onKeepLocal={keepLocalForNow}
        />
      )}
    </>
  )
}
