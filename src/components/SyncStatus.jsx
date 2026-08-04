export default function SyncStatus({ status, pendingCount = 0, syncNow }) {
  if (status === 'local' || (status === 'synced' && pendingCount === 0)) return null

  if (status === 'error') {
    return (
      <div role="status" aria-live="polite">
        <span>Couldn&apos;t sync · </span>
        <button type="button" onClick={syncNow}>Retry</button>
      </div>
    )
  }

  if (status === 'offline') {
    return <div role="status" aria-live="polite">Offline</div>
  }

  if (status === 'syncing') {
    return <div role="status" aria-live="polite">Syncing…</div>
  }

  if (status === 'pending' || pendingCount > 0) {
    return <div role="status" aria-live="polite">Saving locally · {pendingCount} pending</div>
  }

  return null
}
