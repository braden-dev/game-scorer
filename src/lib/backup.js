const FORMAT = 'gamescorer-backup'
const VERSION = 1

function filename() {
  const d = new Date()
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  return `game-scorer-${stamp}.json`
}

export function buildBackup(state) {
  return JSON.stringify(
    {
      format: FORMAT,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      roster: state.roster,
      games: state.games,
    },
    null,
    2,
  )
}

/**
 * Hands the backup to the OS. On phones the share sheet is the only route to
 * something durable (Files, Drive, a message to yourself), so try that first
 * and fall back to a plain download on desktop.
 */
export async function shareOrDownloadBackup(state) {
  const json = buildBackup(state)
  const name = filename()
  const file = new File([json], name, { type: 'application/json' })

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Game Scorer backup' })
      return 'shared'
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled'
      // Fall through to download.
    }
  }

  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return 'downloaded'
}

export function parseBackup(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error("That file isn't valid JSON.")
  }
  if (data?.format !== FORMAT) throw new Error("That doesn't look like a Game Scorer backup.")
  if (!Array.isArray(data.games) || !Array.isArray(data.roster)) {
    throw new Error('That backup is missing its games or players.')
  }
  return data
}

/**
 * Merges a backup into the current state rather than replacing it, so importing
 * on a device that already has games can't silently destroy them. Anything
 * sharing an id is treated as the same record and left alone.
 */
export function mergeBackup(state, backup) {
  const gameIds = new Set(state.games.map((g) => g.id))
  const rosterIds = new Set(state.roster.map((p) => p.id))
  const rosterNames = new Set(state.roster.map((p) => p.name.toLowerCase()))

  const newGames = backup.games.filter((g) => g && g.id && !gameIds.has(g.id))
  const newPlayers = backup.roster.filter(
    (p) => p && p.id && !rosterIds.has(p.id) && !rosterNames.has(p.name?.toLowerCase()),
  )

  return {
    state: {
      ...state,
      games: [...state.games, ...newGames],
      roster: [...state.roster, ...newPlayers],
    },
    added: { games: newGames.length, players: newPlayers.length },
    skipped: {
      games: backup.games.length - newGames.length,
      players: backup.roster.length - newPlayers.length,
    },
  }
}
