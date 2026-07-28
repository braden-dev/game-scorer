import PlayerChip from './PlayerChip.jsx'

export default function Scoreboard({ game, def, standings, target }) {
  const best = standings[0]
  const scale = (total) => {
    if (!target) return 0
    return Math.max(0, Math.min(100, Math.round((total / target) * 100)))
  }

  return (
    <ol className="scoreboard">
      {standings.map((row) => (
        <li key={row.player.id} className={`score-row${row.rank === 1 ? ' leader' : ''}`}>
          <span className="rank">{row.rank}</span>
          <PlayerChip player={row.player} index={row.index} />
          <span className="score-name">
            {row.player.name}
            {row.note && <small className="score-note">{row.note}</small>}
          </span>
          <span className="score-value">
            {row.total.toLocaleString()}
            {target && def.betterIs === 'high' && (
              <small className="score-gap">
                {row.total >= target
                  ? 'target reached'
                  : `${(target - row.total).toLocaleString()} to go`}
              </small>
            )}
            {def.betterIs === 'low' && best && row !== best && (
              <small className="score-gap">+{(row.total - best.total).toLocaleString()}</small>
            )}
          </span>
          {target && def.betterIs === 'high' && (
            <span className="score-bar"><span style={{ width: `${scale(row.total)}%` }} /></span>
          )}
        </li>
      ))}
    </ol>
  )
}
