import { useMemo, useState } from 'react'
import { GAMES, evaluate, getGameDef } from '../games/index.js'
import { navigate } from '../lib/router.js'
import { compareUpdatedAt } from '../lib/time.js'
import { GameCard } from './Home.jsx'

function isFinished(game) {
  return Boolean(game.finishedAt) || evaluate(game).status.finished
}

export function filterGames(games = [], status = 'all', gameType = 'all') {
  return games
    .filter((game) => game && !game.deletedAt && !game.deleted_at && getGameDef(game.gameId))
    .filter((game) => gameType === 'all' || game.gameId === gameType)
    .filter((game) => status === 'all' || (status === 'finished' ? isFinished(game) : !isFinished(game)))
    .sort(compareUpdatedAt)
}

export default function Games({ games = [], onNavigate = navigate }) {
  const [status, setStatus] = useState('all')
  const [gameType, setGameType] = useState('all')
  const gameTypes = useMemo(() => GAMES.filter((definition) => games.some((game) => !game.deletedAt && !game.deleted_at && game.gameId === definition.id)), [games])
  const visibleGames = filterGames(games, status, gameType)

  return (
    <main className="games-page view-page">
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={() => onNavigate({ type: 'home' })} aria-label="Back to home">←</button>
        <div>
          <h1>Games</h1>
          <p className="view-sub">All scorebook history, newest first</p>
        </div>
      </header>

      <nav className="page-nav" aria-label="Scorebook pages">
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'people' })}>People</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'leaderboard' })}>Leaderboard</button>
        <button type="button" className="chip active" onClick={() => onNavigate({ type: 'games' })}>Games</button>
      </nav>

      <div className="filter-bar" aria-label="Game filters">
        <div className="filter-chips" role="group" aria-label="Game status">
          <button type="button" className={`chip ${status === 'all' ? 'active' : ''}`} onClick={() => setStatus('all')}>All games</button>
          <button type="button" className={`chip ${status === 'active' ? 'active' : ''}`} onClick={() => setStatus('active')}>In progress</button>
          <button type="button" className={`chip ${status === 'finished' ? 'active' : ''}`} onClick={() => setStatus('finished')}>Finished</button>
        </div>
        <select aria-label="Filter by game type" value={gameType} onChange={(event) => setGameType(event.target.value)}>
          <option value="all">All game types</option>
          {gameTypes.map((definition) => <option key={definition.id} value={definition.id}>{definition.name}</option>)}
        </select>
      </div>

      {visibleGames.length > 0 ? (
        <ul className="saved-list history-list">
          {visibleGames.map((game) => (
            <GameCard key={game.id} game={game} onOpen={() => onNavigate({ type: 'game', id: game.id })} />
          ))}
        </ul>
      ) : (
        <p className="empty">{games.length ? 'No games match these filters.' : 'No games yet — start one from Home.'}</p>
      )}
    </main>
  )
}
