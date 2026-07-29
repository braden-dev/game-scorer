import { useState } from 'react'
import { num } from '../lib/util.js'
import { NumberField } from '../components/fields.jsx'

const RANKS = [
  { key: 'A', label: 'A', rank: 1 },
  { key: '2', label: '2', rank: 2 },
  { key: '3', label: '3', rank: 3 },
  { key: '4', label: '4', rank: 4 },
  { key: '5', label: '5', rank: 5 },
  { key: '6', label: '6', rank: 6 },
  { key: '7', label: '7', rank: 7 },
  { key: '8', label: '8', rank: 8 },
  { key: '9', label: '9', rank: 9 },
  { key: '10', label: '10', rank: 10 },
  { key: 'J', label: 'J', rank: 11 },
  { key: 'Q', label: 'Q', rank: 12 },
  { key: 'K', label: 'K', rank: 13 },
]

export function cardValue(rankKey, settings) {
  if (rankKey === 'JOKER') return settings.jokerValue
  const r = RANKS.find((x) => x.key === rankKey)
  if (!r) return 0
  if (r.rank === 1) return settings.aceValue
  if (r.rank <= 9) return r.rank
  return settings.faceValue === 'rank' ? r.rank : 10
}

/** Which rank is wild in a given round (round 0 deals 3 cards → 3s wild). */
export function wildFor(roundIndex) {
  const rank = roundIndex + 3
  const found = RANKS.find((r) => r.rank === rank)
  return { rank, label: found ? found.label : String(rank), cards: rank }
}

function HandCalculator({ settings, onUse, onClose }) {
  const [counts, setCounts] = useState({})
  const ranks = settings.jokerValue > 0 ? [...RANKS, { key: 'JOKER', label: '★', rank: 99 }] : RANKS
  const total = Object.entries(counts).reduce((sum, [k, n]) => sum + cardValue(k, settings) * n, 0)
  const cards = Object.values(counts).reduce((a, b) => a + b, 0)

  const bump = (key, delta) =>
    setCounts((prev) => ({ ...prev, [key]: Math.max(0, (prev[key] || 0) + delta) }))

  return (
    <div className="calc">
      <p className="calc-hint">Tap each card still in the hand. Tap the − row to undo.</p>
      <div className="card-grid">
        {ranks.map((r) => (
          <button
            key={r.key}
            type="button"
            className={`playing-card${counts[r.key] ? ' active' : ''}`}
            onClick={() => bump(r.key, 1)}
            onContextMenu={(e) => { e.preventDefault(); bump(r.key, -1) }}
          >
            <span className="pc-rank">{r.label}</span>
            <span className="pc-val">{cardValue(r.key, settings)}</span>
            {counts[r.key] > 0 && <span className="pc-count">{counts[r.key]}</span>}
          </button>
        ))}
      </div>
      <div className="dice-row subtle wrap">
        {ranks.filter((r) => counts[r.key]).map((r) => (
          <button key={r.key} type="button" className="minus" onClick={() => bump(r.key, -1)}>
            −{r.label}
          </button>
        ))}
      </div>
      <div className="calc-result">
        <div className="calc-total">
          <span className="calc-total-value">{total}</span>
          <span className="calc-total-label">penalty · {cards} card{cards === 1 ? '' : 's'}</span>
        </div>
      </div>
      <div className="calc-actions">
        <button type="button" className="btn ghost" onClick={() => setCounts({})}>Clear</button>
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary" onClick={() => onUse(total)}>Use {total}</button>
      </div>
    </div>
  )
}

/**
 * Going out first earns the bonus; anyone else who empties their hand on the
 * final turn simply avoids penalties. Entries saved before the bonus existed
 * have no `first` flag, so they keep scoring 0 exactly as they did.
 */
function scoreEntry(entry, settings) {
  if (entry.first) return settings.firstOutBonus ?? 0
  if (entry.out) return 0
  return num(entry.points)
}

function EntryFields({ entry, setEntry, settings }) {
  const [showCalc, setShowCalc] = useState(false)
  const bonus = settings.firstOutBonus
  const alsoOut = entry.out && !entry.first

  return (
    <div className="entry-fields">
      <div className="entry-main wrap">
        <NumberField
          value={entry.out ? '0' : entry.points}
          onChange={(v) => setEntry({ ...entry, points: v, out: false, first: false })}
          placeholder="0"
          suffix="pts"
        />
        <button
          type="button"
          className={`chip${entry.first ? ' active' : ''}`}
          onClick={() =>
            setEntry(entry.first
              ? { ...entry, first: false, out: false }
              : { ...entry, first: true, out: true, points: '0' })
          }
          title="Ended the round by going out first"
        >
          🥇 Out first
        </button>
        <button
          type="button"
          className={`chip${alsoOut ? ' active' : ''}`}
          onClick={() =>
            setEntry(alsoOut
              ? { ...entry, out: false, first: false }
              : { ...entry, out: true, first: false, points: '0' })
          }
          title="Laid down every card on their last turn"
        >
          ✓ Also out
        </button>
        <button type="button" className="chip" onClick={() => setShowCalc((s) => !s)}>
          {showCalc ? 'Hide cards' : 'Count cards'}
        </button>
      </div>
      {entry.first && (
        <p className={`entry-note${bonus < 0 ? ' good' : ''}`}>
          Went out first — scores {bonus} this round
        </p>
      )}
      {alsoOut && <p className="entry-note">Cleared their hand — scores 0 this round</p>}
      {showCalc && (
        <HandCalculator
          settings={settings}
          onClose={() => setShowCalc(false)}
          onUse={(points) => {
            setEntry({ ...entry, points: String(points), out: false, first: false })
            setShowCalc(false)
          }}
        />
      )}
    </div>
  )
}

function Rules({ settings }) {
  return (
    <div className="rules">
      <h4>How to play</h4>
      <p>
        {settings.rounds} rounds. Round 1 deals 3 cards, round 2 deals 4, and so on up to{' '}
        {settings.rounds + 2} cards in the last round. <strong>The rank matching the deal is wild</strong> — 3s
        are wild when you're dealt 3, 4s when you're dealt 4, up to Kings in the final round.
      </p>
      <p>
        On your turn draw one card (from the stock or the discard pile) and discard one. You're trying to arrange
        your whole hand into <strong>sets</strong> (three or more of a rank) and <strong>runs</strong> (three or
        more in sequence, same suit). Go out by laying down every card but one and discarding it — everyone else
        gets one last turn to lay down whatever they can.
      </p>
      <h4>Scoring</h4>
      <p>Every card you're left holding counts <strong>against</strong> you:</p>
      <ul>
        <li>Ace: {settings.aceValue}</li>
        <li>2–9: face value</li>
        <li>10, J, Q, K: {settings.faceValue === 'rank' ? '10, 11, 12, 13' : '10 each'}</li>
        {settings.jokerValue > 0 && <li>Joker: {settings.jokerValue}</li>}
      </ul>
      <p>
        The first player to go out scores <strong>{settings.firstOutBonus}</strong> for the round. Anyone else
        who manages to lay down their whole hand on that last turn scores 0.
      </p>
      <h4>Winning</h4>
      <p>After all {settings.rounds} rounds, the <strong>lowest</strong> total wins.</p>
    </div>
  )
}

export default {
  id: 'three-thirteen',
  name: '3-13',
  tagline: 'Eleven rounds of rummy, wilds every hand',
  icon: '🃏',
  accent: '#a78bfa',
  minPlayers: 2,
  maxPlayers: 8,
  betterIs: 'low',
  roundNoun: 'Round',
  roundTitle: (i) => {
    const w = wildFor(i)
    return `Round ${i + 1} · ${w.cards} cards · ${w.label}s wild`
  },
  maxRounds: (settings) => settings.rounds,
  defaultSettings: {
    rounds: 11,
    faceValue: 'ten',
    aceValue: 1,
    jokerValue: 0,
    firstOutBonus: -5,
  },
  settingsFields: [
    { key: 'rounds', label: 'Number of rounds', type: 'number', min: 1, max: 11 },
    {
      key: 'firstOutBonus',
      label: 'First player out scores',
      type: 'number',
      min: -50,
      max: 0,
      step: 5,
      help: 'A negative number subtracts from their total. Set to 0 if going out first earns no bonus.',
    },
    {
      key: 'faceValue',
      label: '10, J, Q, K value',
      type: 'select',
      options: [
        { value: 'ten', label: '10 points each' },
        { value: 'rank', label: 'By rank (10 / 11 / 12 / 13)' },
      ],
    },
    {
      key: 'aceValue',
      label: 'Ace value',
      type: 'select',
      options: [
        { value: 1, label: '1 point (ace low)' },
        { value: 15, label: '15 points (ace high or low)' },
      ],
    },
    {
      key: 'jokerValue',
      label: 'Jokers',
      type: 'select',
      options: [
        { value: 0, label: 'Not used' },
        { value: 20, label: 'Wild — 20 points if held' },
      ],
    },
  ],
  blankEntry: () => ({ points: '', out: false, first: false }),
  entryScore: scoreEntry,
  entrySummary: (entry, settings) => {
    if (entry.first) return `🥇 ${settings.firstOutBonus}`
    if (entry.out) return '✓ out'
    return String(num(entry.points))
  },
  EntryFields,
  Rules,

  /**
   * Only one player can go out first — marking someone clears whoever held it
   * before, so the round can't quietly hand out two bonuses.
   */
  normalizeEntries(entries, changedId) {
    if (!entries[changedId]?.first) return entries
    const next = {}
    for (const [id, entry] of Object.entries(entries)) {
      next[id] = id !== changedId && entry.first ? { ...entry, first: false, out: true } : entry
    }
    return next
  },

  roundWarning(entries, players) {
    const anyOut = players.some((p) => entries[p.id]?.out)
    const anyFirst = players.some((p) => entries[p.id]?.first)
    if (anyOut && !anyFirst) {
      return 'Nobody is marked as going out first, so no one gets the bonus this round.'
    }
    return null
  },

  computeTotals(game) {
    const totals = {}
    for (const p of game.players) totals[p.id] = { total: 0, outs: 0, firsts: 0 }
    for (const round of game.rounds) {
      for (const p of game.players) {
        const entry = round.entries[p.id]
        if (!entry) continue
        totals[p.id].total += scoreEntry(entry, game.settings)
        if (entry.out) totals[p.id].outs += 1
        if (entry.first) totals[p.id].firsts += 1
      }
    }
    for (const p of game.players) {
      const t = totals[p.id]
      const bits = []
      if (t.firsts) bits.push(`out first ${t.firsts}×`)
      else if (t.outs) bits.push(`out ${t.outs}×`)
      t.note = bits.length ? bits.join(' · ') : null
    }
    return totals
  },

  checkStatus(game, totals) {
    if (game.rounds.length >= game.settings.rounds) {
      const ranked = game.players
        .map((p) => ({ id: p.id, total: totals[p.id].total }))
        .sort((a, b) => a.total - b.total)
      return { finished: true, winnerId: ranked[0]?.id ?? null }
    }
    return { finished: false, winnerId: null }
  },
}
