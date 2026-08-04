import { access, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { isAbsolute, join, resolve } from 'node:path'

function normalizeBase(base = '/') {
  if (!base || base === '/') return '/'
  return `/${String(base).replace(/^\/+|\/+$/g, '')}/`
}

function localAssetPath(distDir, reference, base) {
  if (!reference || reference.startsWith('#') || reference.startsWith('data:')) return null
  const url = new URL(reference, 'https://game-scorer.invalid')
  if (url.origin !== 'https://game-scorer.invalid') return null
  let pathname = decodeURIComponent(url.pathname)
  if (base !== '/' && pathname.startsWith(base)) pathname = pathname.slice(base.length)
  return resolve(distDir, `.${pathname.startsWith('/') ? pathname : `/${pathname}`}`)
}

export async function assertBuildArtifacts(distDir = 'dist', base = process.env.BUILD_BASE || '/') {
  const normalizedBase = normalizeBase(base)
  const indexPath = join(distDir, 'index.html')
  const fallbackPath = join(distDir, '404.html')
  const index = await readFile(indexPath, 'utf8')
  const fallback = await readFile(fallbackPath, 'utf8')
  if (fallback !== index) throw new Error('404.html must exactly match index.html')

  const references = [...index.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => localAssetPath(distDir, match[1], normalizedBase))
    .filter(Boolean)
  for (const reference of references) {
    if (!isAbsolute(reference) || !reference.startsWith(resolve(distDir))) {
      throw new Error(`Build asset escapes dist: ${reference}`)
    }
    await access(reference)
  }

  return { indexPath, fallbackPath, references }
}

const scriptPath = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  try {
    const result = await assertBuildArtifacts()
    console.log(`Build fallback verified: ${result.fallbackPath}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
