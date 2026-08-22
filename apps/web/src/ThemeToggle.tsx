import type { ComponentType } from 'react'
import { MonitorIcon, MoonIcon, SunIcon } from './Icons.js'
import { useTheme, type Theme } from './theme.js'

const OPTIONS: { value: Theme; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon },
  { value: 'system', label: 'System', Icon: MonitorIcon },
]

/**
 * A radio group rather than a cycling button: three states are hard to
 * discover one click at a time, and "which one am I on" should be visible
 * without pressing anything.
 */
export function ThemeToggle() {
  const { theme, setTheme } = useTheme()

  return (
    <fieldset className="theme-toggle">
      <legend className="sr-only">Colour theme</legend>

      {OPTIONS.map(({ value, label, Icon }) => (
        <label
          key={value}
          className="theme-toggle__option"
          data-active={theme === value}
        >
          <input
            type="radio"
            name="theme"
            value={value}
            checked={theme === value}
            // The visible label is hidden on narrow screens, which would
            // otherwise leave these radios with no accessible name at all.
            aria-label={label}
            onChange={() => setTheme(value)}
          />
          <Icon size={15} />
          <span className="theme-toggle__text">{label}</span>
        </label>
      ))}
    </fieldset>
  )
}
