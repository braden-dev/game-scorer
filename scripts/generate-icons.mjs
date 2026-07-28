// Rasterises assets/icon.svg into the PNG sizes the manifest and iOS need.
// Run with `npm run icons` after editing either SVG.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'public', 'icons')

const TARGETS = [
  { src: 'icon.svg', size: 192, name: 'icon-192.png' },
  { src: 'icon.svg', size: 512, name: 'icon-512.png' },
  { src: 'icon.svg', size: 180, name: 'apple-touch-icon.png' },
  { src: 'icon.svg', size: 32, name: 'favicon-32.png' },
  { src: 'icon-maskable.svg', size: 192, name: 'maskable-192.png' },
  { src: 'icon-maskable.svg', size: 512, name: 'maskable-512.png' },
]

await mkdir(outDir, { recursive: true })

for (const { src, size, name } of TARGETS) {
  const svg = await readFile(join(root, 'assets', src))
  const png = await sharp(svg, { density: 384 })
    .resize(size, size, { fit: 'cover' })
    .png({ compressionLevel: 9 })
    .toBuffer()
  await writeFile(join(outDir, name), png)
  console.log(`${name.padEnd(22)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} kB`)
}

console.log(`\nWrote ${TARGETS.length} icons to public/icons/`)
