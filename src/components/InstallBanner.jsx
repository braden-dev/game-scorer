import { useState } from 'react'
import { isIos, isStandalone } from '../lib/useInstallPrompt.js'

const DISMISS_KEY = 'gamescorer.installDismissed'

export default function InstallBanner({ install }) {
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === '1')

  if (dismissed || isStandalone()) return null
  // Nothing useful to say on desktop browsers that can't install either.
  if (!install.canInstall && !isIos()) return null

  const hide = () => {
    localStorage.setItem(DISMISS_KEY, '1')
    setDismissed(true)
  }

  return (
    <div className="install-banner">
      <span className="install-icon">📲</span>
      <div className="install-copy">
        <strong>Add to your home screen</strong>
        <span>
          {install.canInstall
            ? 'Runs offline, keeps your scores safe, no browser bar.'
            : 'Tap Share, then “Add to Home Screen” — runs offline and keeps your scores safe.'}
        </span>
      </div>
      {install.canInstall && (
        <button type="button" className="btn primary" onClick={install.install}>Install</button>
      )}
      <button type="button" className="icon-btn" onClick={hide} aria-label="Dismiss">✕</button>
    </div>
  )
}
