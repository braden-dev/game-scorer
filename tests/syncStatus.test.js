import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('uses the exact sync error wording with an actionable retry', async () => {
  const source = await readFile(new URL('../src/components/SyncStatus.jsx', import.meta.url), 'utf8')

  assert.match(source, /Couldn&apos;t sync ·/)
  assert.match(source, /<button type="button" onClick=\{syncNow\}>Retry<\/button>/)
})
