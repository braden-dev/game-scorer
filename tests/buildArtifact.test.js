import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertBuildArtifacts } from '../scripts/assert-build.mjs'

test('assertBuildArtifacts requires a matching SPA fallback and loadable app assets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'game-scorer-build-'))
  try {
    await mkdir(join(directory, 'assets'))
    const index = '<script type="module" src="/GameScorer/assets/app-123.js"></script><link href="/GameScorer/assets/app-123.css" rel="stylesheet">'
    await writeFile(join(directory, 'index.html'), index)
    await writeFile(join(directory, '404.html'), index)
    await writeFile(join(directory, 'assets/app-123.js'), '')
    await writeFile(join(directory, 'assets/app-123.css'), '')

    await assert.doesNotReject(() => assertBuildArtifacts(directory, '/GameScorer/'))

    await writeFile(join(directory, '404.html'), '<!doctype html>')
    await assert.rejects(
      () => assertBuildArtifacts(directory, '/GameScorer/'),
      /404\.html must exactly match index\.html/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
