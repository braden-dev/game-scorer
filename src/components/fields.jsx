export function NumberField({ value, onChange, placeholder = '0', label, suffix, autoFocus, allowNegative }) {
  return (
    <label className="numfield">
      {label && <span className="numfield-label">{label}</span>}
      <span className="numfield-box">
        <input
          type="text"
          inputMode={allowNegative ? 'text' : 'numeric'}
          pattern={allowNegative ? '-?[0-9]*' : '[0-9]*'}
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          onFocus={(e) => e.target.select()}
          onChange={(e) => {
            const raw = e.target.value
            const re = allowNegative ? /^-?\d*$/ : /^\d*$/
            if (re.test(raw)) onChange(raw)
          }}
        />
        {suffix && <span className="numfield-suffix">{suffix}</span>}
      </span>
    </label>
  )
}

export function Stepper({ value, onChange, min = 0, max = 99, label }) {
  return (
    <div className="stepper">
      {label && <span className="stepper-label">{label}</span>}
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="decrease">−</button>
      <span className="stepper-value">{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="increase">+</button>
    </div>
  )
}

export function Toggle({ checked, onChange, children }) {
  return (
    <button
      type="button"
      className={`toggle${checked ? ' on' : ''}`}
      onClick={() => onChange(!checked)}
      aria-pressed={checked}
    >
      <span className="toggle-dot" />
      {children}
    </button>
  )
}

export function SettingsForm({ fields, settings, onChange }) {
  return (
    <div className="settings-grid">
      {fields.map((f) => (
        <div className="setting" key={f.key}>
          <label htmlFor={`set-${f.key}`}>{f.label}</label>
          {f.type === 'select' ? (
            <select
              id={`set-${f.key}`}
              value={settings[f.key]}
              onChange={(e) => {
                const raw = e.target.value
                const opt = f.options.find((o) => String(o.value) === raw)
                onChange(f.key, opt ? opt.value : raw)
              }}
            >
              {f.options.map((o) => (
                <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
              ))}
            </select>
          ) : (
            <input
              id={`set-${f.key}`}
              type="number"
              value={settings[f.key]}
              min={f.min}
              max={f.max}
              step={f.step || 1}
              onChange={(e) => onChange(f.key, e.target.value === '' ? '' : Number(e.target.value))}
            />
          )}
          {f.help && <p className="setting-help">{f.help}</p>}
        </div>
      ))}
    </div>
  )
}
