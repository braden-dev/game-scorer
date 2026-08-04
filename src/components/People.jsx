import { useState } from 'react'
import { buildPersonStats } from '../lib/stats.js'
import { navigate } from '../lib/router.js'
import PlayerChip from './PlayerChip.jsx'

export function filterPeople(roster = [], query = '') {
  const normalizedQuery = query.trim().toLowerCase()
  return roster.filter((person) => (
    person && !person.deletedAt && !person.deleted_at && (!normalizedQuery || String(person.name || '').toLowerCase().includes(normalizedQuery))
  ))
}

function formatRate(rate) {
  return `${Math.round(rate * 100)}%`
}

export default function People({ roster = [], games = [], onNavigate = navigate }) {
  const [query, setQuery] = useState('')
  const people = filterPeople(roster, query)
  const liveGames = games.filter((game) => !game.deletedAt)

  return (
    <main className="directory view-page">
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={() => onNavigate({ type: 'home' })} aria-label="Back to home">←</button>
        <div>
          <h1>People</h1>
          <p className="view-sub">Everyone in the shared scorebook</p>
        </div>
      </header>

      <nav className="page-nav" aria-label="Scorebook pages">
        <button type="button" className="chip active" onClick={() => onNavigate({ type: 'people' })}>People</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'leaderboard' })}>Leaderboard</button>
        <button type="button" className="chip" onClick={() => onNavigate({ type: 'games' })}>Games</button>
      </nav>

      <label className="search-label">
        <span>Search people</span>
        <input
          type="search"
          value={query}
          placeholder="Find someone…"
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>

      {people.length > 0 ? (
        <ul className="directory-list">
          {people.map((person, index) => {
            const stats = buildPersonStats(person.id, liveGames)
            return (
              <li key={person.id} className="directory-card">
                <button
                  type="button"
                  className="directory-open"
                  onClick={() => onNavigate({ type: 'person', id: person.id })}
                >
                  <PlayerChip player={person} index={index} />
                  <span className="directory-info">
                    <strong>{person.name}</strong>
                    <span className="directory-meta">
                      {stats.games} game{stats.games === 1 ? '' : 's'} · {stats.wins} win{stats.wins === 1 ? '' : 's'} · {formatRate(stats.winRate)} win rate
                    </span>
                  </span>
                  <span className="directory-arrow" aria-hidden="true">→</span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="empty">{query ? 'No people match that search.' : 'No people yet — add someone when you start a game.'}</p>
      )}
    </main>
  )
}
