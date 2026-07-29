import { useEffect, useState } from 'react'
import { loadState, saveState } from './lib/storage.js'
import { uid } from './lib/util.js'
import { getGameDef, evaluate, migrateState } from './games/index.js'
import { useInstallPrompt } from './lib/useInstallPrompt.js'
import Home from './components/Home.jsx'
import NewGame from './components/NewGame.jsx'
import GameView from './components/GameView.jsx'
import DataPanel from './components/DataPanel.jsx'
import InstallBanner from './components/InstallBanner.jsx'

export default function App() {
  const [state, setState] = useState(() => migrateState(loadState()))
  const [newGameId, setNewGameId] = useState(null)
  const [showData, setShowData] = useState(false)
  const install = useInstallPrompt()

  useEffect(() => { saveState(state) }, [state])

  // A record for a game this build doesn't know about would crash every screen
  // that scores it. That happens for real: an installed PWA can be running a
  // cached older build when a backup from a newer one is imported. Hide those
  // rather than render them — they stay in storage and reappear after an update.
  const playableGames = state.games.filter((g) => getGameDef(g.gameId))
  const activeGame = playableGames.find((g) => g.id === state.activeGameId) || null

  const addToRoster = (name) => {
    const person = { id: uid('p'), name }
    setState((prev) => ({ ...prev, roster: [...prev.roster, person] }))
    return person
  }

  const removeFromRoster = (id) =>
    setState((prev) => ({ ...prev, roster: prev.roster.filter((p) => p.id !== id) }))

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
    setState((prev) => ({ ...prev, games: [...prev.games, game], activeGameId: game.id }))
    setNewGameId(null)
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
    setState((prev) => ({
      ...prev,
      games: prev.games.map((g) => (g.id === next.id ? next : g)),
    }))
  }

  const deleteGame = (id) => {
    const game = state.games.find((g) => g.id === id)
    const def = game ? getGameDef(game.gameId) : null
    const label = def ? `this ${def.name} game` : 'this game'
    if (!window.confirm(`Delete ${label}? This can't be undone.`)) return
    setState((prev) => ({
      ...prev,
      games: prev.games.filter((g) => g.id !== id),
      activeGameId: prev.activeGameId === id ? null : prev.activeGameId,
    }))
  }

  const rematch = () => {
    if (!activeGame) return
    startGame(activeGame.gameId, activeGame.players, { ...activeGame.settings })
  }

  if (newGameId) {
    return (
      <NewGame
        gameId={newGameId}
        roster={state.roster}
        onCancel={() => setNewGameId(null)}
        onStart={(players, settings) => startGame(newGameId, players, settings)}
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
        onBack={() => setState((prev) => ({ ...prev, activeGameId: null }))}
        onRematch={rematch}
        onAddToRoster={addToRoster}
      />
    )
  }

  return (
    <>
      <Home
        games={playableGames}
        onNew={setNewGameId}
        onOpen={(id) => setState((prev) => ({ ...prev, activeGameId: id }))}
        onDelete={deleteGame}
        onOpenData={() => setShowData(true)}
        installBanner={<InstallBanner install={install} />}
      />
      {showData && (
        <DataPanel
          state={state}
          install={install}
          onImport={(imported) => setState(migrateState(imported))}
          onClose={() => setShowData(false)}
        />
      )}
    </>
  )
}
