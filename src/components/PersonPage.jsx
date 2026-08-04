import { buildGameBreakdown, buildPersonStats } from '../lib/stats.js'
import { navigate } from '../lib/router.js'
import { getGameDef } from '../games/index.js'
import { GameCard } from './Home.jsx'

function formatAverage(value) {
  return value == null ? '—' : value.toFixed(2)
}

function formatMetricName(name) {
  return name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
}

function metricValue(value) {
  return typeof value === 'number' && !Number.isInteger(value) ? value.toFixed(2) : String(value)
}

export default function PersonPage({ personId, roster = [], games = [], onNavigate = navigate }) {
  const person = roster.find((entry) => entry.id === personId)
  const liveGames = games.filter((game) => game && !game.deletedAt && !game.deleted_at)

  if (!person || person.deletedAt || person.deleted_at) {
    return (
      <main className="view-page">
        <header className="view-head">
          <button type="button" className="icon-btn" onClick={() => onNavigate({ type: 'people' })} aria-label="Back to people">←</button>
          <h1>Person not found</h1>
        </header>
        <p className="empty" role="alert">That person is no longer in the shared directory.</p>
      </main>
    )
  }

  const stats = buildPersonStats(person.id, liveGames)
  const breakdown = buildGameBreakdown(person.id, liveGames)
  const recentGames = liveGames
    .filter((game) => game.players?.some((player) => player.id === person.id) && getGameDef(game.gameId))
    .sort((first, second) => {
      const firstTime = Number.isFinite(Number(first.updatedAt)) ? Number(first.updatedAt) : Date.parse(String(first.updatedAt || '')) || 0
      const secondTime = Number.isFinite(Number(second.updatedAt)) ? Number(second.updatedAt) : Date.parse(String(second.updatedAt || '')) || 0
      return secondTime - firstTime
    })
  const favorite = stats.favoriteGame ? getGameDef(stats.favoriteGame)?.name ?? stats.favoriteGame : '—'

  return (
    <main className="person-page view-page">
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={() => onNavigate({ type: 'people' })} aria-label="Back to people">←</button>
        <div>
          <h1>{person.name}</h1>
          <p className="view-sub">Scorebook history and stats</p>
        </div>
      </header>

      <section className="stats-summary" aria-label={`${person.name} summary`}>
        <div><strong>{stats.games}</strong><span>Games</span></div>
        <div><strong>{stats.wins}</strong><span>Wins</span></div>
        <div><strong>{Math.round(stats.winRate * 100)}%</strong><span>Win rate</span></div>
        <div><strong>{formatAverage(stats.averageFinish)}</strong><span>Average finish</span></div>
      </section>

      {stats.games === 0 && (
        <p className="empty person-empty">No finished games yet. In-progress games still appear in Recent games below.</p>
      )}

      <section className="panel stats-section">
        <h2 className="section-title">Per-game breakdown</h2>
        {breakdown.length > 0 ? (
          <div className="breakdown-list">
            {breakdown.map((entry) => {
              const definition = getGameDef(entry.gameId)
              return (
                <article key={entry.gameId} className="breakdown-card">
                  <div className="breakdown-head">
                    <strong>{definition?.icon} {definition?.name ?? entry.gameId}</strong>
                    <span>{entry.wins} win{entry.wins === 1 ? '' : 's'} · {Math.round(entry.winRate * 100)}%</span>
                  </div>
                  <span className="muted">{entry.games} game{entry.games === 1 ? '' : 's'} · {formatAverage(entry.averageFinish)} average finish</span>
                  {Object.keys(entry.gameSpecific).length > 0 && (
                    <div className="metric-row">
                      {Object.entries(entry.gameSpecific).map(([name, value]) => (
                        <span key={name}>{formatMetricName(name)}: <strong>{value == null ? '—' : metricValue(value)}</strong></span>
                      ))}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        ) : <p className="muted">Per-game stats appear after a finished game.</p>}
      </section>

      <section className="panel stats-section">
        <h2 className="section-title">Fun stats</h2>
        <dl className="fun-stats">
          <div><dt>Longest win streak</dt><dd>{stats.longestWinStreak}</dd></div>
          <div><dt>Favorite game</dt><dd>{favorite}</dd></div>
          <div><dt>Most-played teammate</dt><dd>{stats.mostPlayedTeammate ? `${stats.mostPlayedTeammate.name} (${stats.mostPlayedTeammate.games})` : '—'}</dd></div>
        </dl>
      </section>

      <section className="stats-section">
        <h2 className="section-title">Recent games</h2>
        {recentGames.length > 0 ? (
          <ul className="saved-list">
            {recentGames.map((game) => (
              <GameCard key={game.id} game={game} onOpen={() => onNavigate({ type: 'game', id: game.id })} />
            ))}
          </ul>
        ) : <p className="muted">No games involving {person.name} yet.</p>}
      </section>
    </main>
  )
}
