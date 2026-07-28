import { initials, playerColor } from '../lib/util.js'

export default function PlayerChip({ player, index, size = 'md' }) {
  return (
    <span
      className={`avatar ${size}`}
      style={{ '--chip': playerColor(index) }}
      title={player.name}
    >
      {initials(player.name)}
    </span>
  )
}
