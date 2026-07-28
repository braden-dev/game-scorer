import { useState } from 'react'
import { getGameDef } from '../games/index.js'
import { SettingsForm } from './fields.jsx'
import PlayerChip from './PlayerChip.jsx'

export default function NewGame({ gameId, roster, onCancel, onStart, onAddToRoster, onRemoveFromRoster }) {
  const def = getGameDef(gameId)
  const [selected, setSelected] = useState([])
  const [name, setName] = useState('')
  const [settings, setSettings] = useState({ ...def.defaultSettings })
  const [showSettings, setShowSettings] = useState(false)

  const toggle = (personId) =>
    setSelected((prev) =>
      prev.includes(personId) ? prev.filter((x) => x !== personId) : [...prev, personId])

  const addPerson = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    const existing = roster.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
    if (existing) {
      if (!selected.includes(existing.id)) toggle(existing.id)
    } else {
      const person = onAddToRoster(trimmed)
      setSelected((prev) => [...prev, person.id])
    }
    setName('')
  }

  const move = (index, delta) => {
    setSelected((prev) => {
      const next = prev.slice()
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      ;[next[index], next[target]] = [next[target], next[index]]
      return next
    })
  }

  const players = selected.map((id) => roster.find((p) => p.id === id)).filter(Boolean)
  const enough = players.length >= def.minPlayers
  const tooMany = players.length > def.maxPlayers

  return (
    <div className="newgame" style={{ '--accent': def.accent }}>
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Back">←</button>
        <div>
          <h1>New {def.name}</h1>
          <p className="view-sub">{def.tagline}</p>
        </div>
      </header>

      <section className="panel">
        <h2 className="section-title">Who's playing?</h2>
        {players.length > 0 && (
          <ol className="turn-order">
            {players.map((p, i) => (
              <li key={p.id}>
                <span className="turn-num">{i + 1}</span>
                <PlayerChip player={p} index={i} size="sm" />
                <span className="turn-name">{p.name}</span>
                <span className="turn-actions">
                  <button type="button" className="icon-btn" onClick={() => move(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                  <button type="button" className="icon-btn" onClick={() => move(i, 1)} disabled={i === players.length - 1} aria-label="Move down">↓</button>
                  <button type="button" className="icon-btn" onClick={() => toggle(p.id)} aria-label="Remove">✕</button>
                </span>
              </li>
            ))}
          </ol>
        )}

        <form className="add-player" onSubmit={addPerson}>
          <input
            type="text"
            value={name}
            placeholder="Add a player…"
            onChange={(e) => setName(e.target.value)}
            maxLength={24}
          />
          <button type="submit" className="btn primary" disabled={!name.trim()}>Add</button>
        </form>

        {roster.filter((p) => !selected.includes(p.id)).length > 0 && (
          <>
            <p className="hint">Tap to add someone you've played with before:</p>
            <div className="roster">
              {roster.filter((p) => !selected.includes(p.id)).map((p) => (
                <span key={p.id} className="roster-chip">
                  <button type="button" onClick={() => toggle(p.id)}>{p.name}</button>
                  <button
                    type="button"
                    className="roster-x"
                    onClick={() => onRemoveFromRoster(p.id)}
                    aria-label={`Forget ${p.name}`}
                  >✕</button>
                </span>
              ))}
            </div>
          </>
        )}

        {!enough && (
          <p className="warn">
            Needs at least {def.minPlayers} player{def.minPlayers === 1 ? '' : 's'}.
          </p>
        )}
        {tooMany && <p className="warn">{def.name} plays best with up to {def.maxPlayers} players — you have {players.length}.</p>}
      </section>

      <section className="panel">
        <button type="button" className="disclosure" onClick={() => setShowSettings((s) => !s)}>
          <span>House rules</span>
          <span className="disclosure-arrow">{showSettings ? '▾' : '▸'}</span>
        </button>
        {showSettings && (
          <SettingsForm
            fields={def.settingsFields}
            settings={settings}
            onChange={(key, value) => setSettings((prev) => ({ ...prev, [key]: value }))}
          />
        )}
      </section>

      <div className="sticky-actions">
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="btn primary big"
          disabled={!enough}
          onClick={() => onStart(players, settings)}
        >
          Start game
        </button>
      </div>
    </div>
  )
}
