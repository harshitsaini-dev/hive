import type { SVGProps } from 'react'

/**
 * Inline SVG icon set.
 *
 * Drawn by hand rather than pulled from a library: the set is small, and a
 * dependency would add a package, a bundle cost and a licence to track for a
 * dozen paths. Everything strokes in `currentColor`, so icons follow the
 * surrounding text through a theme change with no extra work.
 *
 * Icons are decorative unless given a `title` — the surrounding text carries
 * the meaning, and an unlabelled duplicate just makes screen readers repeat
 * themselves.
 */

type IconProps = SVGProps<SVGSVGElement> & {
  /** Supply only when the icon is the sole conveyor of meaning. */
  title?: string
  size?: number
}

function Icon({ title, size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...rest}
    >
      {title && <title>{title}</title>}
      {children}
    </svg>
  )
}

/** The product mark: a honeycomb cell. */
export function HiveMark({ size = 22, ...rest }: IconProps) {
  return (
    <Icon size={size} {...rest}>
      <path d="M12 2.5 20.5 7.4v9.2L12 21.5 3.5 16.6V7.4z" />
      <path d="M12 8.2 16.2 10.6v4.8L12 17.8 7.8 15.4v-4.8z" opacity={0.45} />
    </Icon>
  )
}

export function SunIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </Icon>
  )
}

export function MoonIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z" />
    </Icon>
  )
}

/** "System" — a display, i.e. whatever the device is set to. */
export function MonitorIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8 20.5h8M12 16.5v4" />
    </Icon>
  )
}

export function SearchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 5 5" />
    </Icon>
  )
}

export function TrashIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3.5 6.5h17M9 6.5V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M5.5 6.5 6.6 19a1.6 1.6 0 0 0 1.6 1.5h7.6a1.6 1.6 0 0 0 1.6-1.5L18.5 6.5" />
      <path d="M10 10.5v6M14 10.5v6" />
    </Icon>
  )
}

/** Scheduled rules — a clock with a repeat arrow. */
export function ScheduleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12.5" r="7.5" />
      <path d="M12 8.5v4.5l3 1.8" />
      <path d="M12 2.5a4 4 0 0 1 3.5 2M15.5 2v2.5H13" />
    </Icon>
  )
}

export function SendIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M21 3 10.5 13.5" />
      <path d="M21 3l-6.8 18-3.7-7.5L3 9.8z" />
    </Icon>
  )
}

export function MailIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <path d="m3.5 7 8.5 6 8.5-6" />
    </Icon>
  )
}

export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 2.5 20 5.5v6c0 5-3.4 8.6-8 10-4.6-1.4-8-5-8-10v-6z" />
      <path d="m8.8 12 2.2 2.2 4.2-4.4" />
    </Icon>
  )
}

export function GithubIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 19.5c-4.3 1.3-4.3-2.2-6-2.7m12 5.2v-3.4a2.9 2.9 0 0 0-.8-2.3c2.7-.3 5.5-1.3 5.5-6a4.7 4.7 0 0 0-1.3-3.2 4.3 4.3 0 0 0-.1-3.3s-1.1-.3-3.5 1.3a12 12 0 0 0-6.4 0C6 3.5 4.9 3.8 4.9 3.8a4.3 4.3 0 0 0-.1 3.3 4.7 4.7 0 0 0-1.3 3.3c0 4.6 2.8 5.6 5.5 6a2.9 2.9 0 0 0-.8 2.2v3.4" />
    </Icon>
  )
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </Icon>
  )
}

export function PlusIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  )
}

export function LogoutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 3.5H5.5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2H9" />
      <path d="M16 16.5l4.5-4.5L16 7.5M20 12H9" />
    </Icon>
  )
}

export function AlertIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5M12 16.2v.1" />
    </Icon>
  )
}

export function CheckIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Icon>
  )
}

export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      <path d="M12 14.5v2.5" />
    </Icon>
  )
}

/** Offline — a disconnected plug. */
export function PlugIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M9 2.5v5M15 2.5v5" />
      <path d="M6.5 7.5h11v3a5.5 5.5 0 0 1-11 0z" />
      <path d="M12 16v5.5" />
      <path d="m3 3 18 18" />
    </Icon>
  )
}

export function ServerIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="4" width="18" height="7" rx="1.5" />
      <rect x="3" y="13" width="18" height="7" rx="1.5" />
      <path d="M7 7.5v.1M7 16.5v.1" />
    </Icon>
  )
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3v11" />
      <path d="m7.5 10 4.5 4.5 4.5-4.5" />
      <path d="M4 17.5v1.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
    </Icon>
  )
}

export function PaperclipIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.6-8.6a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.9-7.9" />
    </Icon>
  )
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  )
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m15 18-6-6 6-6" />
    </Icon>
  )
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 18 6-6-6-6" />
    </Icon>
  )
}

export function CalendarIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </Icon>
  )
}

export function ChartIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 15v-4M12 17V7M17 17v-7" />
    </Icon>
  )
}

export function MenuIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 6h16M4 12h16M4 18h16" />
    </Icon>
  )
}

export function CloseIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  )
}
