import { useMemo, useState } from 'react'
import { num } from '../lib/util.js'
import { NumberField } from '../components/fields.jsx'
import { scoreDice, describeDice } from './farkleScoring.js'

const DIE_PIPS = {
  1: [[1, 1]],
  2: [[0, 0], [2, 2]],
  3: [[0, 0], [1, 1], [2, 2]],
  4: [[0, 0], [0, 2], [2, 0], [2, 2]],
  5: [[0, 0], [0, 2], [1, 1], [2, 0], [2, 2]],
  6: [[0, 0], [0, 1], [0, 2], [2, 0], [2, 1], [2, 2]],
}

function Die({ face, count, onClick, active }) {
  return (
    <button type="button" className={`die${active ? ' active' : ''}`} onClick={onClick}>
      <span className="die-face">
        {DIE_PIPS[face].map(([r, c], i) => (
          <span key={i} className="pip" style={{ gridRow: r + 1, gridColumn: c + 1 }} />
        ))}
      </span>
      <span className="die-count">{count}</span>
    </button>
  )
}

function Calculator({ settings, onUse, onClose }) {
  const [counts, setCounts] = useState([0, 0, 0, 0, 0, 0, 0])
  const used = counts.reduce((a, b) => a + b, 0)
  const result = useMemo(() => scoreDice(counts, settings), [counts, settings])
  const breakdown = useMemo(() => (used ? describeDice(counts, settings) : []), [counts, settings, used])
  const hot = used === 6 && result.dice === 6

  const bump = (face, delta) => {
    setCounts((prev) => {
      const total = prev.reduce((a, b) => a + b, 0)
      if (delta > 0 && total >= 6) return prev
      const next = prev.slice()
      next[face] = Math.max(0, next[face] + delta)
      return next
    })
  }

  return (
    <div className="calc">
      <p className="calc-hint">Tap a die to add it ({6 - used} left). Right-click or long-press to remove.</p>
      <div className="dice-row">
        {[1, 2, 3, 4, 5, 6].map((face) => (
          <Die
            key={face}
            face={face}
            count={counts[face]}
            active={counts[face] > 0}
            onClick={() => bump(face, 1)}
          />
        ))}
      </div>
      <div className="dice-row subtle">
        {[1, 2, 3, 4, 5, 6].map((face) => (
          <button key={face} type="button" className="minus" onClick={() => bump(face, -1)} disabled={!counts[face]}>
            −{face}
          </button>
        ))}
      </div>

      <div className="calc-result">
        <div className="calc-total">
          <span className="calc-total-value">{result.score.toLocaleString()}</span>
          <span className="calc-total-label">points</span>
        </div>
        <ul className="calc-breakdown">
          {breakdown.length === 0 && <li className="muted">Select the dice you set aside.</li>}
          {breakdown.map((b, i) => (
            <li key={i} className={b.points === 0 ? 'muted' : ''}>
              <span>{b.label}</span>
              <span>{b.points ? b.points.toLocaleString() : '—'}</span>
            </li>
          ))}
        </ul>
        {used > 0 && result.score === 0 && <p className="calc-flag farkle">Farkle! No scoring dice.</p>}
        {hot && <p className="calc-flag hot">Hot dice — all six scored, roll again!</p>}
      </div>

      <div className="calc-actions">
        <button type="button" className="btn ghost" onClick={() => setCounts([0, 0, 0, 0, 0, 0, 0])}>Clear</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => onUse(result.score)}>
          Add {result.score.toLocaleString()}
        </button>
      </div>
    </div>
  )
}

function EntryFields({ entry, setEntry, settings, totals, player }) {
  const [showCalc, setShowCalc] = useState(false)
  const onBoard = totals?.[player.id]?.onBoard
  const value = num(entry.score)
  const wouldBank = onBoard || value >= settings.opening

  return (
    <div className="entry-fields">
      <div className="entry-main">
        <NumberField
          value={entry.score}
          onChange={(v) => setEntry({ ...entry, score: v })}
          placeholder="0"
          suffix="pts"
        />
        <button type="button" className="chip danger" onClick={() => setEntry({ ...entry, score: '0' })}>
          Farkle
        </button>
        <button type="button" className="chip" onClick={() => setShowCalc((s) => !s)}>
          {showCalc ? 'Hide dice' : 'Dice calc'}
        </button>
      </div>
      {!onBoard && settings.opening > 0 && (
        <p className={`entry-note${wouldBank ? ' good' : ''}`}>
          {wouldBank
            ? `Gets on the board (needs ${settings.opening.toLocaleString()}+)`
            : `Not on the board yet — needs ${settings.opening.toLocaleString()}+ in one turn to bank`}
        </p>
      )}
      {showCalc && (
        <Calculator
          settings={settings}
          onClose={() => setShowCalc(false)}
          onUse={(score) => {
            setEntry({ ...entry, score: String(num(entry.score) + score) })
            setShowCalc(false)
          }}
        />
      )}
    </div>
  )
}

function Rules({ settings }) {
  const s = settings
  return (
    <div className="rules">
      <h4>How to play</h4>
      <p>
        Roll six dice. Set aside at least one scoring die, then choose to bank your points or re-roll the
        remaining dice for more. If a roll produces no scoring dice at all, you <strong>Farkle</strong> and lose
        everything you accumulated that turn. If all six dice score, you have <strong>hot dice</strong> — roll all
        six again and keep building.
      </p>
      <h4>Scoring</h4>
      <table className="rules-table">
        <tbody>
          <tr><td>Single 1</td><td>100</td></tr>
          <tr><td>Single 5</td><td>50</td></tr>
          <tr><td>Three 1s</td><td>1,000</td></tr>
          <tr><td>Three 2s / 3s / 4s / 5s / 6s</td><td>200 / 300 / 400 / 500 / 600</td></tr>
          <tr>
            <td>Four / five / six of a kind</td>
            <td>{s.multiRule === 'double' ? 'Triple value doubled per extra die' : '1,000 / 2,000 / 3,000'}</td>
          </tr>
          <tr><td>Straight 1-2-3-4-5-6</td><td>{s.straight ? s.straight.toLocaleString() : 'off'}</td></tr>
          <tr><td>Three pairs</td><td>{s.threePairs ? s.threePairs.toLocaleString() : 'off'}</td></tr>
          <tr><td>Two triplets</td><td>{s.twoTriplets ? s.twoTriplets.toLocaleString() : 'off'}</td></tr>
        </tbody>
      </table>
      <h4>Winning</h4>
      <p>
        {s.opening > 0 && <>You must bank {s.opening.toLocaleString()}+ points in a single turn to get on the board. </>}
        First to {s.target.toLocaleString()} points wins — everyone finishes the round so all players get the same
        number of turns.
      </p>
    </div>
  )
}

export default {
  id: 'farkle',
  name: 'Farkle',
  tagline: 'Push your luck with six dice',
  icon: '🎲',
  accent: '#f97316',
  minPlayers: 2,
  maxPlayers: 12,
  betterIs: 'high',
  roundNoun: 'Turn',
  roundTitle: (i) => `Turn ${i + 1}`,
  maxRounds: () => null,
  defaultSettings: {
    target: 10000,
    opening: 500,
    straight: 1500,
    threePairs: 1500,
    twoTriplets: 2500,
    multiRule: 'fixed',
  },
  settingsFields: [
    { key: 'target', label: 'Target score', type: 'number', min: 500, step: 500 },
    { key: 'opening', label: 'Points to get on the board', type: 'number', min: 0, step: 50, help: 'Set to 0 to let players bank from their first turn.' },
    { key: 'straight', label: 'Straight (1-6)', type: 'number', min: 0, step: 100 },
    { key: 'threePairs', label: 'Three pairs', type: 'number', min: 0, step: 100 },
    { key: 'twoTriplets', label: 'Two triplets', type: 'number', min: 0, step: 100, help: '0 disables this combination.' },
    {
      key: 'multiRule',
      label: '4 / 5 / 6 of a kind',
      type: 'select',
      options: [
        { value: 'fixed', label: 'Flat 1,000 / 2,000 / 3,000' },
        { value: 'double', label: 'Double the triple per extra die' },
      ],
    },
  ],
  blankEntry: () => ({ score: '' }),
  entryScore: (entry) => num(entry.score),
  entrySummary: (entry) => {
    const v = num(entry.score)
    return v === 0 ? 'Farkle' : `${v.toLocaleString()}`
  },
  EntryFields,
  Rules,

  computeTotals(game) {
    const totals = {}
    for (const p of game.players) totals[p.id] = { total: 0, onBoard: game.settings.opening <= 0 }
    for (const round of game.rounds) {
      for (const p of game.players) {
        const entry = round.entries[p.id]
        if (!entry) continue
        const value = num(entry.score)
        const t = totals[p.id]
        if (!t.onBoard) {
          if (value >= game.settings.opening) {
            t.onBoard = true
            t.total += value
          }
          // Otherwise nothing banks — the player stays off the board.
        } else {
          t.total += value
        }
      }
    }
    for (const p of game.players) {
      const t = totals[p.id]
      t.note = t.onBoard ? null : 'not on board'
    }
    return totals
  },

  checkStatus(game, totals) {
    const leaders = game.players
      .map((p) => ({ id: p.id, total: totals[p.id].total }))
      .sort((a, b) => b.total - a.total)
    const top = leaders[0]
    if (game.rounds.length > 0 && top && top.total >= game.settings.target) {
      return { finished: true, winnerId: top.id }
    }
    return { finished: false, winnerId: null }
  },
}
