import { useState } from 'react'
import Modal from './Modal.jsx'
import PlayerChip from './PlayerChip.jsx'

export default function RoundSheet({ game, def, roundIndex, existing, totals, onSave, onDelete, onClose }) {
  const [entries, setEntries] = useState(() => {
    const seed = {}
    for (const p of game.players) {
      seed[p.id] = existing?.entries?.[p.id]
        ? { ...existing.entries[p.id] }
        : def.blankEntry()
    }
    return seed
  })

  // Some games have rules that span the whole round — 3-13 allows only one
  // player to go out first — so the game gets a chance to reconcile the others.
  const setEntry = (playerId, entry) =>
    setEntries((prev) => {
      const next = { ...prev, [playerId]: entry }
      return def.normalizeEntries ? def.normalizeEntries(next, playerId, game.players) : next
    })

  const isEdit = Boolean(existing)
  const warning = def.roundWarning?.(entries, game.players, game.settings)

  return (
    <Modal
      wide
      title={def.roundTitle(roundIndex, game.settings)}
      subtitle={isEdit ? 'Editing a saved round' : `Enter every player's score for this ${def.roundNoun.toLowerCase()}`}
      onClose={onClose}
      footer={
        <>
          {isEdit && (
            <button type="button" className="btn danger-ghost" onClick={onDelete}>
              Delete {def.roundNoun.toLowerCase()}
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn primary" onClick={() => onSave(entries)}>
            {isEdit ? 'Save changes' : `Save ${def.roundNoun.toLowerCase()}`}
          </button>
        </>
      }
    >
      <div className="round-entries">
        {game.players.map((player, i) => (
          <div className="round-entry" key={player.id}>
            <div className="round-entry-head">
              <PlayerChip player={player} index={i} size="sm" />
              <span className="round-entry-name">{player.name}</span>
              <span className="round-entry-total">
                {totals[player.id]?.total?.toLocaleString() ?? 0}
                <small> total</small>
              </span>
            </div>
            <def.EntryFields
              entry={entries[player.id]}
              setEntry={(e) => setEntry(player.id, e)}
              settings={game.settings}
              totals={totals}
              player={player}
              roundIndex={roundIndex}
            />
          </div>
        ))}
      </div>
      {warning && <p className="round-warning">{warning}</p>}
    </Modal>
  )
}
