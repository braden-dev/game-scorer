import React from 'react'

export function createSyncStatusElement({ status, pendingCount = 0, syncNow }) {
  if (status === 'local' || (status === 'synced' && pendingCount === 0)) return null

  const props = { role: 'status', 'aria-live': 'polite' }
  if (status === 'conflict') return React.createElement('div', props, 'Sync conflict · review shared result')
  if (status === 'error') {
    return React.createElement(
      'div',
      props,
      React.createElement('span', null, "Couldn't sync · "),
      React.createElement('button', { type: 'button', onClick: syncNow }, 'Retry'),
    )
  }

  if (status === 'offline') return React.createElement('div', props, 'Will retry when online')
  if (status === 'syncing') return React.createElement('div', props, 'Syncing…')
  if (status === 'pending' || pendingCount > 0) {
    return React.createElement('div', props, 'Saving locally')
  }
  return null
}
