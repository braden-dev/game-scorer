import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('Pages build receives only public Supabase Vite variables', async () => {
  const workflow = await readFile(new URL('../.github/workflows/deploy.yml', import.meta.url), 'utf8')
  const buildStep = workflow.match(/- name: Build[\s\S]*?(?=\n\s*- uses:|$)/)?.[0] ?? ''

  assert.match(buildStep, /env:\s*\n\s+VITE_SUPABASE_URL:\s+\$\{\{\s*vars\.VITE_SUPABASE_URL\s*\}\}/)
  assert.match(buildStep, /VITE_SUPABASE_PUBLISHABLE_KEY:\s+\$\{\{\s*vars\.VITE_SUPABASE_PUBLISHABLE_KEY\s*\}\}/)
  assert.doesNotMatch(buildStep, /SERVICE_ROLE|DB_PASSWORD|SUPABASE_SERVICE_ROLE|DATABASE_PASSWORD/i)
})

test('README documents cloud-first configuration, migration checks, and frontend secret boundaries', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')

  assert.match(readme, /VITE_SUPABASE_URL/)
  assert.match(readme, /VITE_SUPABASE_PUBLISHABLE_KEY/)
  assert.match(readme, /cache|outbox|sync/i)
  assert.match(readme, /public and editable/i)
  assert.match(readme, /db lint/)
  assert.match(readme, /db push/)
  assert.match(readme, /service-role|database password/i)
})

test('DataPanel explains Supabase Free-plan availability and backup limits', async () => {
  const panel = await readFile(new URL('../src/components/DataPanel.jsx', import.meta.url), 'utf8')

  assert.match(panel, /Free projects may pause/i)
  assert.match(panel, /automatic downloadable database backups/i)
  assert.match(panel, /Export every so often|JSON backup/i)
})

test('PersonPage displays best finish as an explicit fun stat', async () => {
  const page = await readFile(new URL('../src/components/PersonPage.jsx', import.meta.url), 'utf8')

  assert.match(page, /Best finish/)
  assert.match(page, /stats\.bestFinish/)
})
