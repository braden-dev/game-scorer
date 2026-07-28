import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages serves this from /<repo>/, so the deploy workflow sets
// BUILD_BASE. Locally everything runs from the root.
const base = process.env.BUILD_BASE || '/'

export default defineConfig({
  base,
  server: { port: 5173, open: true },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon-32.png'],
      manifest: {
        name: 'Game Scorer',
        short_name: 'Scorer',
        description: 'Score keeper for Farkle, Dutch Blitz, and 3-13.',
        theme_color: '#0b0f16',
        background_color: '#0b0f16',
        display: 'standalone',
        // Absolute, not '.' — iOS resolves a relative start_url against the
        // manifest's own location, which silently sends the installed app to
        // the wrong path. Safari also opens links in the browser rather than
        // the app when scope is left unset.
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
          { src: 'icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,webmanifest}'],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
})
