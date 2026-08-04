import test from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createSyncStatusElement } from '../src/components/SyncStatusView.js'

test('renders retry behavior for a sync error and nothing for clean synced state', () => {
  let retries = 0
  const errorElement = createSyncStatusElement({
    status: 'error',
    pendingCount: 0,
    syncNow: () => { retries += 1 },
  })
  const errorMarkup = renderToStaticMarkup(errorElement)
  const cleanMarkup = renderToStaticMarkup(createSyncStatusElement({
    status: 'synced',
    pendingCount: 0,
    syncNow: () => {},
  }))

  assert.match(errorMarkup, /Couldn(?:&#x27;|')t sync ·/)
  assert.match(errorMarkup, /<button[^>]*>Retry<\/button>/)
  assert.equal(cleanMarkup, '')
  errorElement.props.children[1].props.onClick()
  assert.equal(retries, 1)
})

test('renders quiet offline and pending statuses', () => {
  const offlineMarkup = renderToStaticMarkup(createSyncStatusElement({
    status: 'offline',
    pendingCount: 2,
    syncNow: () => {},
  }))
  const pendingMarkup = renderToStaticMarkup(createSyncStatusElement({
    status: 'pending',
    pendingCount: 2,
    syncNow: () => {},
  }))

  assert.match(offlineMarkup, /Will retry when online/)
  assert.doesNotMatch(offlineMarkup, /Retry/)
  assert.equal(pendingMarkup, '<div role="status" aria-live="polite">Saving locally</div>')
})

test('renders terminal conflicts without an action button', () => {
  const conflictElement = createSyncStatusElement({
    status: 'conflict',
    pendingCount: 0,
    syncNow: () => { throw new Error('terminal conflicts are not retryable') },
  })

  const conflictMarkup = renderToStaticMarkup(conflictElement)
  assert.match(conflictMarkup, /review shared result/)
  assert.doesNotMatch(conflictMarkup, /local changes kept/)
  assert.doesNotMatch(conflictMarkup, /Retry/)
  assert.doesNotMatch(conflictMarkup, /<button/)
})
