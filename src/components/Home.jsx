import { GAMES, evaluate } from '../games/index.js'
import { relativeDate } from '../lib/util.js'
import { navigate } from '../lib/router.js'
import PlayerChip from './PlayerChip.jsx'

export function GameCard({ game, onOpen, onDelete }) {
  const { def, standings, status } = evaluate(game)
  const leader = standings[0]
  return (
    <li className="saved-game" style={{ '--accent': def.accent }}>
      <button type="button" className="saved-open" onClick={onOpen}>
        <span className="saved-icon">{def.icon}</span>
        <span className="saved-info">
          <span className="saved-title">
            {def.name}
            {status.finished && <span className="badge done">Finished</span>}
          </span>
          <span className="saved-meta">
            {game.players.length} player{game.players.length === 1 ? '' : 's'} ·{' '}
            {game.rounds.length} {def.roundNoun.toLowerCase()}
            {game.rounds.length === 1 ? '' : 's'} · {relativeDate(game.updatedAt)}
          </span>
          {leader && (
            <span className="saved-leader">
              {status.finished ? '🏆' : 'Leading:'} {leader.player.name} · {leader.total.toLocaleString()}
            </span>
          )}
        </span>
        <span className="saved-players">
          {game.players.slice(0, 5).map((p, i) => (
            <PlayerChip key={p.id} player={p} index={i} size="sm" />
          ))}
        </span>
      </button>
      {onDelete && <button type="button" className="icon-btn danger" onClick={onDelete} aria-label="Delete game">🗑</button>}
    </li>
  )
}

export default function Home({ games, onNew, onOpen, onDelete, onOpenData, installBanner, onNavigate = navigate }) {
  const sorted = [...games].sort((a, b) => b.updatedAt - a.updatedAt)
  const active = sorted.filter((g) => !g.finishedAt)
  const done = sorted.filter((g) => g.finishedAt)

  return (
    <div className="home">
      <header className="hero">
        <div className="hero-row">
          <h1>Game Scorer</h1>
          <button type="button" className="icon-btn" onClick={onOpenData} aria-label="Data and backup">⋯</button>
        </div>
        <p>Keep score for the games you actually play. Everything saves to this device.</p>
      </header>

      {installBanner}

      <nav className="page-nav" aria-label="Scorebook pages">
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'people' })}>People</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'leaderboard' })}>Leaderboard</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'games' })}>Games</button>
      </nav>

      <section>
        <h2 className="section-title">Start a game</h2>
        <div className="game-picker">
          {GAMES.map((g) => (
            <button
              key={g.id}
              type="button"
              className="game-tile"
              style={{ '--accent': g.accent }}
              onClick={() => onNew(g.id)}
            >
              <span className="tile-icon">{g.icon}</span>
              <span className="tile-name">{g.name}</span>
              <span className="tile-tag">{g.tagline}</span>
            </button>
          ))}
        </div>
      </section>

      {active.length > 0 && (
        <section>
          <h2 className="section-title">In progress</h2>
          <ul className="saved-list">
            {active.map((g) => (
              <GameCard key={g.id} game={g} onOpen={() => onOpen(g.id)} onDelete={() => onDelete(g.id)} />
            ))}
          </ul>
        </section>
      )}

      {done.length > 0 && (
        <section>
          <h2 className="section-title">Finished</h2>
          <ul className="saved-list">
            {done.map((g) => (
              <GameCard key={g.id} game={g} onOpen={() => onOpen(g.id)} onDelete={() => onDelete(g.id)} />
            ))}
          </ul>
        </section>
      )}

      {games.length === 0 && (
        <p className="empty">No games yet — pick one above to get started.</p>
      )}
    </div>
  )
}
