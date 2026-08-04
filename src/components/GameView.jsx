import { useState } from 'react'
import { evaluate, getGameDef, normalizeGameSettings } from '../games/index.js'
import { uid } from '../lib/util.js'
import { useWakeLock } from '../lib/useWakeLock.js'
import Modal from './Modal.jsx'
import Scoreboard from './Scoreboard.jsx'
import RoundSheet from './RoundSheet.jsx'
import PlayerChip from './PlayerChip.jsx'
import { SettingsForm } from './fields.jsx'

export default function GameView({ game: rawGame, roster, onUpdate, onBack, onRematch, onAddToRoster }) {
  const gameDef = getGameDef(rawGame.gameId)
  const game = gameDef
    ? { ...rawGame, settings: normalizeGameSettings(rawGame.gameId, rawGame.settings) }
    : rawGame
  const { def, totals, standings, status } = evaluate(game)
  const [sheet, setSheet] = useState(null) // { roundIndex, existing }
  const [panel, setPanel] = useState(null) // 'rules' | 'settings' | 'players'
  const [newName, setNewName] = useState('')

  // Keep the screen awake while a game is in play — a scorekeeper that dims
  // every 30 seconds is useless on a table.
  useWakeLock(!status.finished)

  const maxRounds = def.maxRounds(game.settings)
  const roundsLeft = maxRounds ? maxRounds - game.rounds.length : null
  const canAddRound = !status.finished && (maxRounds === null || game.rounds.length < maxRounds)

  const saveRound = (entries) => {
    const rounds = game.rounds.slice()
    if (sheet.existing) {
      const updatedAt = Math.max(Date.now(), (Number(rounds[sheet.roundIndex].updatedAt) || 0) + 1)
      rounds[sheet.roundIndex] = { ...rounds[sheet.roundIndex], entries, updatedAt }
    } else {
      rounds.push({ id: uid('r'), entries, updatedAt: Date.now() })
    }
    onUpdate({ ...game, rounds })
    setSheet(null)
  }

  const deleteRound = () => {
    const noun = def.roundNoun.toLowerCase()
    if (!window.confirm(`Delete this ${noun}? Undo is available for 10 seconds.`)) return
    const rounds = game.rounds.filter((_, i) => i !== sheet.roundIndex)
    onUpdate({ ...game, rounds })
    setSheet(null)
  }

  const addPlayer = (e) => {
    e.preventDefault()
    const trimmed = newName.trim()
    if (!trimmed) return
    const existing = roster.find((p) => p.name.toLowerCase() === trimmed.toLowerCase())
    const person = existing || onAddToRoster(trimmed)
    if (game.players.some((p) => p.id === person.id)) return
    onUpdate({ ...game, players: [...game.players, { id: person.id, name: person.name }] })
    setNewName('')
  }

  const removePlayer = (playerId) => {
    const players = game.players.filter((p) => p.id !== playerId)
    const rounds = game.rounds.map((r) => {
      const entries = { ...r.entries }
      delete entries[playerId]
      return { ...r, entries }
    })
    onUpdate({ ...game, players, rounds })
  }

  const winners = standings.filter((row) => row.rank === 1)
  const winnerNames = winners.map((row) => row.player.name)
  const winnerLabel = winnerNames.length === 1
    ? `${winnerNames[0]} wins!`
    : `${winnerNames.slice(0, -1).join(', ')} and ${winnerNames.at(-1)} win!`

  return (
    <div className="gameview" style={{ '--accent': def.accent }}>
      <header className="view-head">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back to games">←</button>
        <div>
          <h1>{def.icon} {def.name}</h1>
          <p className="view-sub">
            {game.rounds.length} {def.roundNoun.toLowerCase()}{game.rounds.length === 1 ? '' : 's'} played
            {roundsLeft !== null && roundsLeft > 0 && ` · ${roundsLeft} to go`}
            {def.betterIs === 'high' && ` · first to ${game.settings.target.toLocaleString()}`}
            {def.betterIs === 'low' && ' · lowest score wins'}
          </p>
        </div>
        <div className="head-actions">
          <button type="button" className="icon-btn" onClick={() => setPanel('players')} aria-label="Players">👥</button>
          <button type="button" className="icon-btn" onClick={() => setPanel('rules')} aria-label="Rules">?</button>
          <button type="button" className="icon-btn" onClick={() => setPanel('settings')} aria-label="House rules">⚙</button>
        </div>
      </header>

      {status.finished && winners.length > 0 && (
        <div className="winner-banner">
          <span className="trophy">🏆</span>
          <div>
            <strong>{winnerLabel}</strong>
            <span>{totals[winners[0].player.id].total.toLocaleString()} points</span>
          </div>
          <button type="button" className="btn ghost" onClick={onRematch}>Rematch</button>
        </div>
      )}

      <Scoreboard
        game={game}
        def={def}
        standings={standings}
        target={def.betterIs === 'high' ? game.settings.target : null}
      />

      {canAddRound && (
        <button type="button" className="btn primary big full" onClick={() => setSheet({ roundIndex: game.rounds.length, existing: null })}>
          + Add {def.roundNoun.toLowerCase()} {game.rounds.length + 1}
        </button>
      )}

      {game.rounds.length > 0 && (
        <section className="history">
          <h2 className="section-title">History <small>tap a row to edit</small></h2>
          <div className="table-scroll">
            <table className="history-table">
              <thead>
                <tr>
                  <th className="sticky-col">{def.roundNoun}</th>
                  {game.players.map((p, i) => (
                    <th key={p.id}>
                      <PlayerChip player={p} index={i} size="sm" />
                      <span>{p.name}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {game.rounds.map((round, i) => (
                  <tr
                    key={round.id}
                    onClick={() => setSheet({ roundIndex: i, existing: round })}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setSheet({ roundIndex: i, existing: round })
                    }}
                    role="button"
                    aria-label={`Edit ${def.roundNoun.toLowerCase()} ${i + 1}`}
                    tabIndex={0}
                  >
                    <th className="sticky-col">{i + 1}</th>
                    {game.players.map((p) => (
                      <td key={p.id}>
                        {round.entries[p.id] ? def.entrySummary(round.entries[p.id], game.settings) : '–'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th className="sticky-col">Total</th>
                  {game.players.map((p) => (
                    <td key={p.id}><strong>{totals[p.id].total.toLocaleString()}</strong></td>
                  ))}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>
      )}

      {sheet && (
        <RoundSheet
          game={game}
          def={def}
          roundIndex={sheet.roundIndex}
          existing={sheet.existing}
          totals={totals}
          onSave={saveRound}
          onDelete={deleteRound}
          onClose={() => setSheet(null)}
        />
      )}

      {panel === 'rules' && (
        <Modal title={`${def.name} rules`} onClose={() => setPanel(null)} wide>
          <def.Rules settings={game.settings} />
        </Modal>
      )}

      {panel === 'settings' && (
        <Modal
          title="House rules"
          subtitle="Changing these recalculates every round already entered."
          onClose={() => setPanel(null)}
        >
          <SettingsForm
            fields={def.settingsFields}
            settings={game.settings}
            onChange={(key, value) => onUpdate({ ...game, settings: { ...game.settings, [key]: value } })}
          />
        </Modal>
      )}

      {panel === 'players' && (
        <Modal title="Players" subtitle="Add someone late or drop a player." onClose={() => setPanel(null)}>
          <ul className="player-manage">
            {game.players.map((p, i) => (
              <li key={p.id}>
                <PlayerChip player={p} index={i} size="sm" />
                <span>{p.name}</span>
                <span className="muted">{totals[p.id].total.toLocaleString()}</span>
                <button
                  type="button"
                  className="icon-btn danger"
                  onClick={() => removePlayer(p.id)}
                  disabled={game.players.length <= 1}
                  aria-label={`Remove ${p.name}`}
                >✕</button>
              </li>
            ))}
          </ul>
          <form className="add-player" onSubmit={addPlayer}>
            <input
              type="text"
              value={newName}
              placeholder="Add a player…"
              onChange={(e) => setNewName(e.target.value)}
              maxLength={24}
            />
            <button type="submit" className="btn primary" disabled={!newName.trim()}>Add</button>
          </form>
          <p className="hint">Players added mid-game score 0 for rounds they missed — edit past rounds to backfill.</p>
        </Modal>
      )}
    </div>
  )
}
