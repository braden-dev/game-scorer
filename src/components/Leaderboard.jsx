import { buildLeaderboard } from '../lib/stats.js'
import { navigate } from '../lib/router.js'
import PlayerChip from './PlayerChip.jsx'

function sameScore(first, second) {
  return first.wins === second.wins
    && first.winRate === second.winRate
    && first.averageFinish === second.averageFinish
}

function displayAverage(value) {
  return value == null ? '—' : value.toFixed(2)
}

export default function Leaderboard({ games = [], roster, onNavigate = navigate }) {
  const entries = buildLeaderboard(games)
  const activeIds = Array.isArray(roster)
    ? new Set(roster.filter((person) => person && !person.deletedAt && !person.deleted_at).map((person) => person.id))
    : null
  const ranked = entries
    .filter((entry) => !activeIds || activeIds.has(entry.personId))
    .map((entry, index, filtered) => ({
      ...entry,
      rank: index > 0 && sameScore(entry, filtered[index - 1]) ? filtered[index - 1].rank : index + 1,
    }))

  return (
    <main className="leaderboard-page view-page">
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={() => onNavigate({ type: 'home' })} aria-label="Back to home">←</button>
        <div>
          <h1>Leaderboard</h1>
          <p className="view-sub">Finished games only</p>
        </div>
      </header>

      <nav className="page-nav" aria-label="Scorebook pages">
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'people' })}>People</button>
        <button type="button" className="chip active" onClick={() => onNavigate({ type: 'leaderboard' })}>Leaderboard</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'games' })}>Games</button>
      </nav>

      {ranked.length > 0 ? (
        <ol className="leaderboard-list">
          {ranked.map((entry, index) => (
            <li key={entry.personId} className="leaderboard-row">
              <button type="button" className="leaderboard-open" onClick={() => onNavigate({ type: 'person', id: entry.personId })}>
                <span className="rank">{entry.rank}</span>
                <PlayerChip player={{ id: entry.personId, name: entry.name }} index={index} />
                <span className="leaderboard-name">
                  <strong>{entry.name}</strong>
                  <span>{entry.wins} win{entry.wins === 1 ? '' : 's'} · {entry.games} game{entry.games === 1 ? '' : 's'}</span>
                </span>
                <span className="leaderboard-metrics">
                  <strong>{Math.round(entry.winRate * 100)}%</strong>
                  <span>{displayAverage(entry.averageFinish)} avg finish</span>
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="empty">Finish a game to see the leaderboard. In-progress games do not count yet.</p>
      )}
    </main>
  )
}
