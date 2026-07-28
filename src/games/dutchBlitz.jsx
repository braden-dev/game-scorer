import { num } from '../lib/util.js'
import { NumberField } from '../components/fields.jsx'

function EntryFields({ entry, setEntry, settings }) {
  const dutch = num(entry.dutch)
  const blitz = num(entry.blitz)
  const score = dutch - settings.blitzPenalty * blitz

  return (
    <div className="entry-fields">
      <div className="entry-main wrap">
        <NumberField
          label="Dutch pile cards"
          value={entry.dutch}
          onChange={(v) => setEntry({ ...entry, dutch: v })}
          suffix="+1 ea"
        />
        <NumberField
          label="Blitz pile left"
          value={entry.blitz}
          onChange={(v) => setEntry({ ...entry, blitz: v, blitzed: v === '' ? entry.blitzed : v === '0' })}
          suffix={`−${settings.blitzPenalty} ea`}
        />
        <button
          type="button"
          className={`chip${entry.blitzed ? ' active' : ''}`}
          onClick={() =>
            setEntry(entry.blitzed
              ? { ...entry, blitzed: false }
              : { ...entry, blitzed: true, blitz: '0' })
          }
          title="Called Blitz — emptied their Blitz pile"
        >
          ⚡ Blitz!
        </button>
      </div>
      <p className={`entry-note${score >= 0 ? ' good' : ' bad'}`}>
        {dutch} − ({settings.blitzPenalty} × {blitz}) = <strong>{score > 0 ? `+${score}` : score}</strong> this round
      </p>
    </div>
  )
}

function Rules({ settings }) {
  return (
    <div className="rules">
      <h4>How to play</h4>
      <p>
        Everyone plays at once, no turns. Each player has their own 40-card deck in one of four colours: a{' '}
        <strong>Blitz pile</strong> of 10 cards, three <strong>Post piles</strong>, and a Wood pile in hand.
        Race to play cards to the shared <strong>Dutch piles</strong> in the middle — those start with a 1 of any
        colour and build up to 10 in the same colour.
      </p>
      <p>
        Post piles build down in alternating colours (Dutch Blitz colours alternate boy/girl), and you flip your
        Wood pile three cards at a time. The round ends the instant someone empties their Blitz pile and shouts{' '}
        <strong>“Blitz!”</strong>
      </p>
      <h4>Scoring</h4>
      <ul>
        <li>Every card you played into a Dutch pile: <strong>+1</strong></li>
        <li>Every card left in your Blitz pile: <strong>−{settings.blitzPenalty}</strong></li>
      </ul>
      <p>Sort the middle piles by colour to count each player's contribution.</p>
      <h4>Winning</h4>
      <p>Keep playing rounds until someone reaches {settings.target} points. Highest score wins.</p>
    </div>
  )
}

export default {
  id: 'dutch-blitz',
  name: 'Dutch Blitz',
  tagline: 'A vonderful goot game — fast and loud',
  icon: '⚡',
  accent: '#facc15',
  minPlayers: 2,
  maxPlayers: 4,
  betterIs: 'high',
  roundNoun: 'Round',
  roundTitle: (i) => `Round ${i + 1}`,
  maxRounds: () => null,
  defaultSettings: {
    target: 75,
    blitzPenalty: 2,
  },
  settingsFields: [
    { key: 'target', label: 'Target score', type: 'number', min: 10, step: 5 },
    { key: 'blitzPenalty', label: 'Penalty per Blitz card left', type: 'number', min: 0, step: 1 },
  ],
  blankEntry: () => ({ dutch: '', blitz: '', blitzed: false }),
  entryScore: (entry, settings) => num(entry.dutch) - settings.blitzPenalty * num(entry.blitz),
  entrySummary: (entry, settings) => {
    const s = num(entry.dutch) - settings.blitzPenalty * num(entry.blitz)
    return `${s > 0 ? '+' : ''}${s}${entry.blitzed ? ' ⚡' : ''}`
  },
  EntryFields,
  Rules,

  computeTotals(game) {
    const totals = {}
    for (const p of game.players) totals[p.id] = { total: 0, blitzes: 0 }
    for (const round of game.rounds) {
      for (const p of game.players) {
        const entry = round.entries[p.id]
        if (!entry) continue
        totals[p.id].total += num(entry.dutch) - game.settings.blitzPenalty * num(entry.blitz)
        if (entry.blitzed) totals[p.id].blitzes += 1
      }
    }
    for (const p of game.players) {
      const b = totals[p.id].blitzes
      totals[p.id].note = b ? `${b} blitz${b > 1 ? 'es' : ''}` : null
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
