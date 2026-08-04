import { useState } from 'react'

export default function MigrationPanel({ state, onPublish, onKeepLocal }) {
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState(null)
  const roundCount = state.games.reduce((sum, game) => sum + game.rounds.length, 0)

  const publish = async () => {
    setPublishing(true)
    setError(null)
    try {
      await onPublish()
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="migration-title">
      <h2 id="migration-title">Publish local history?</h2>
      <p className="hint">
        Share <strong>{state.games.length}</strong> game{state.games.length === 1 ? '' : 's'},{' '}
        <strong>{roundCount}</strong> round{roundCount === 1 ? '' : 's'}, and{' '}
        <strong>{state.roster.length}</strong> player{state.roster.length === 1 ? '' : 's'} with your
        family and friends.
      </p>
      <p className="hint">
        The shared scorebook is public and editable. Your existing JSON backup will not be changed.
      </p>
      <div className="data-actions">
        <button type="button" className="btn primary" onClick={publish} disabled={publishing}>
          Publish to shared scorebook
        </button>
        <button type="button" className="btn ghost" onClick={onKeepLocal} disabled={publishing}>
          Keep local for now
        </button>
      </div>
      {error && <p className="data-status bad">{error}</p>}
    </section>
  )
}
