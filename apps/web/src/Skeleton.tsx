/**
 * Loading placeholders.
 *
 * These mirror the shape of what is coming, so the page does not reflow when
 * real content lands — a spinner in the middle of an empty page tells you
 * nothing about what to expect, and then everything jumps.
 *
 * Each block is hidden from assistive technology and the surrounding view
 * announces "Loading…" once via a live region instead. Otherwise a screen
 * reader reads out a dozen meaningless boxes.
 */

export function Skeleton({
  width,
  height = '1rem',
  radius = '0.35rem',
}: {
  width?: string
  height?: string
  radius?: string
}) {
  return (
    <span
      className="skeleton"
      style={{ width: width ?? '100%', height, borderRadius: radius }}
      aria-hidden="true"
    />
  )
}

/** Placeholder rows for the message list. */
export function MessageListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <ul className="messages" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index}>
          <div className="message message--skeleton">
            <Skeleton width="1rem" height="1rem" radius="0.25rem" />
            <span className="message__body">
              <span className="message__top">
                {/* Varying widths so it reads as content, not as a grid. */}
                <Skeleton width={`${5 + ((index * 3) % 5)}rem`} height="0.85rem" />
                <Skeleton width="2.5rem" height="0.7rem" />
              </span>
              <Skeleton width={`${45 + ((index * 11) % 40)}%`} height="0.85rem" />
              <Skeleton width={`${60 + ((index * 7) % 30)}%`} height="0.75rem" />
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

export function AccountListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <ul className="accounts" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index}>
          <Skeleton width={`${9 + index * 2}rem`} height="1rem" />
          <Skeleton width="4.5rem" height="0.85rem" />
        </li>
      ))}
    </ul>
  )
}

export function RuleListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <ul className="rules__list" aria-hidden="true">
      {Array.from({ length: rows }, (_, index) => (
        <li key={index}>
          <div className="rules__meta">
            <Skeleton width={`${11 + index * 3}rem`} height="1rem" />
            <Skeleton width={`${14 + index * 2}rem`} height="0.75rem" />
          </div>
          <Skeleton width="9rem" height="1.9rem" radius="0.5rem" />
        </li>
      ))}
    </ul>
  )
}

/** Whole-page placeholder, used while the session is still being resolved. */
export function PageSkeleton() {
  return (
    <div className="page-skeleton" aria-hidden="true">
      <Skeleton width="12rem" height="1.6rem" />
      <Skeleton width="22rem" height="1rem" />
      <div className="page-skeleton__card">
        <Skeleton width="8rem" height="1.1rem" />
        <Skeleton height="2.5rem" radius="0.5rem" />
        <Skeleton height="2.5rem" radius="0.5rem" />
      </div>
    </div>
  )
}
