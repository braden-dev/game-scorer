import { useRef, useState } from 'react'
import Modal from './Modal.jsx'
import { mergeBackup, parseBackup, shareOrDownloadBackup } from '../lib/backup.js'
import { isIos, isStandalone } from '../lib/useInstallPrompt.js'
import SyncStatus from './SyncStatus.jsx'

export default function DataPanel({
  state,
  onImport,
  onClose,
  install,
  sync,
  migrationPending = false,
  onPublishMigration,
  getReconciledCloudState,
}) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const fileRef = useRef(null)

  const gameCount = state.games.length
  const roundCount = state.games.reduce((sum, g) => sum + g.rounds.length, 0)
  const reconciledCloudState = getReconciledCloudState?.() ?? null

  const doExport = async () => {
    setError(null)
    try {
      const result = await shareOrDownloadBackup(state)
      if (result === 'cancelled') setStatus(null)
      else setStatus(result === 'shared' ? 'Backup shared.' : 'Backup downloaded.')
    } catch {
      setError("Couldn't create the backup file.")
    }
  }

  const doImport = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setError(null)
    setStatus(null)
    try {
      const backup = parseBackup(await file.text())
      const { state: merged, added, skipped } = mergeBackup(state, backup)
      onImport(merged)
      const parts = []
      if (added.games) parts.push(`${added.games} game${added.games === 1 ? '' : 's'}`)
      if (added.players) parts.push(`${added.players} player${added.players === 1 ? '' : 's'}`)
      setStatus(
        parts.length
          ? `Added ${parts.join(' and ')}.${skipped.games ? ` ${skipped.games} already here.` : ''}`
          : 'Nothing new — everything in that file is already here.',
      )
    } catch (err) {
      setError(err.message)
    }
  }

  const doCloudExport = async () => {
    setError(null)
    if (!reconciledCloudState) {
      setError('Cloud backup is unavailable until the first successful cloud sync.')
      return
    }
    try {
      const result = await shareOrDownloadBackup(reconciledCloudState)
      if (result === 'cancelled') setStatus(null)
      else setStatus(result === 'shared' ? 'Cloud backup shared.' : 'Cloud backup downloaded.')
    } catch {
      setError("Couldn't create the cloud backup file.")
    }
  }

  const doPublishMigration = async () => {
    setError(null)
    setPublishing(true)
    try {
      await onPublishMigration()
      setStatus('Local history published.')
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : String(publishError))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <Modal title="Data & backup" onClose={onClose}>
      <p className="panel-stat">
        <strong>{gameCount}</strong> game{gameCount === 1 ? '' : 's'} ·{' '}
        <strong>{roundCount}</strong> round{roundCount === 1 ? '' : 's'} ·{' '}
        <strong>{state.roster.length}</strong> player{state.roster.length === 1 ? '' : 's'} saved
      </p>

      {sync && (
        <div className="data-status">
          <SyncStatus {...sync} />
        </div>
      )}

      {sync?.error && (
        <p className="data-status conflict" role="status" aria-live="polite">{sync.error}</p>
      )}

      {sync && migrationPending && onPublishMigration && (
        <div className="data-actions">
          <button type="button" className="btn ghost" onClick={doPublishMigration} disabled={publishing}>
            Publish local history
          </button>
        </div>
      )}

      <div className="data-actions">
        <button type="button" className="btn primary" onClick={doExport}>Export backup</button>
        {sync && (
          <button
            type="button"
            className="btn primary"
            onClick={doCloudExport}
            disabled={!reconciledCloudState}
            title={reconciledCloudState ? undefined : 'Available after the first successful cloud sync'}
          >
            {reconciledCloudState ? 'Export cloud backup' : 'Cloud backup unavailable'}
          </button>
        )}
        <button type="button" className="btn ghost" onClick={() => fileRef.current?.click()}>Import backup</button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={doImport}
          hidden
        />
      </div>

      {status && <p className="data-status good" role="status" aria-live="polite">{status}</p>}
      {error && <p className="data-status bad" role="alert" aria-live="assertive">{error}</p>}
      {sync && !reconciledCloudState && (
        <p className="hint" role="status" aria-live="polite">
          Cloud backup becomes available after the first successful cloud sync.
        </p>
      )}

      <p className="hint">
        Importing merges — it adds games this device doesn't have and never overwrites what's
        already here.
      </p>

      {sync && (
        <p className="hint">
          The shared scorebook is public and editable by anyone with its link. This device keeps a
          local cache for offline play, while Export cloud backup saves the reconciled shared view.
        </p>
      )}

      <h4 className="data-head">Keeping your history safe</h4>
      <p className="hint">
        Scores live in this browser's storage. Installing to your home screen is what keeps them
        around long-term — iOS clears storage for sites you haven't opened in 7 days, but exempts
        installed apps. Export every so often anyway.
      </p>

      {!isStandalone() && (
        <div className="install-box">
          {install?.canInstall ? (
            <>
              <p>Install Game Scorer for offline use and a home screen icon.</p>
              <button type="button" className="btn primary" onClick={install.install}>Install app</button>
            </>
          ) : isIos() ? (
            <p>
              <strong>On iPhone:</strong> open this page in Safari, tap the Share button, then{' '}
              <strong>Add to Home Screen</strong>.
            </p>
          ) : (
            <p>
              <strong>On Android:</strong> open the browser menu and tap{' '}
              <strong>Install app</strong> or <strong>Add to Home screen</strong>.
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
