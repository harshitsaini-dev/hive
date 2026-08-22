import {
  HiveMark,
  ScheduleIcon,
  SearchIcon,
  SendIcon,
  ShieldIcon,
  TrashIcon,
} from './Icons.js'
import { InstallButton } from './InstallButton.js'
import { ThemeToggle } from './ThemeToggle.js'

const FEATURES = [
  {
    Icon: SearchIcon,
    title: 'One inbox, every account',
    body: 'Search across all your connected mailboxes at once, using the Gmail syntax you already know — from:, has:attachment, older_than:, label:.',
  },
  {
    Icon: TrashIcon,
    title: 'Clean out thousands at a time',
    body: 'Select a whole search result and move it to Trash with live progress. It lands in Gmail’s own Trash, so you have thirty days to change your mind.',
  },
  {
    Icon: ScheduleIcon,
    title: 'Rules that run without you',
    body: 'Save a search and let it run on a schedule. “Promotions older than 30 days, weekly” and you stop thinking about it.',
  },
  {
    Icon: SendIcon,
    title: 'Send from any of them',
    body: 'Compose from whichever identity fits, with a quota indicator so a bulk send never fails silently against Google’s daily limit.',
  },
  {
    Icon: ShieldIcon,
    title: 'A Trash you control',
    body: 'Browse the bin across every account, restore anything you did not mean to clear, or empty it for good when you want the storage back now rather than in thirty days.',
  },
]

export function LandingPage({
  onGetStarted,
  onLegal,
}: {
  onGetStarted: () => void
  onLegal: (kind: 'privacy' | 'terms') => void
}) {
  return (
    <div className="landing">
      <header className="landing__bar">
        <span className="landing__mark">
          <HiveMark size={22} />
          Hive
        </span>

        <div className="landing__bar-actions">
          <ThemeToggle />
          <InstallButton className="btn-outline" />
          <button type="button" onClick={onGetStarted}>
            Sign in
          </button>
        </div>
      </header>

      <main className="shell">
        <section className="hero">
          <h1>Manage several Gmail accounts from one place.</h1>
          <p className="hero__sub">
            Search across all of them at once, clear out the clutter in bulk,
            and send from whichever identity you need — without juggling
            browser profiles.
          </p>

          <div className="hero__actions">
            <button type="button" onClick={onGetStarted}>
              Get started
            </button>
            <InstallButton className="btn-outline" />
          </div>

          <p className="hint">
            No password to remember — we email you a code when you sign in.
          </p>
        </section>

        <section className="features" aria-label="What Hive does">
          {FEATURES.map((feature) => (
            <article key={feature.title} className="feature">
              <span className="feature__icon">
                <feature.Icon size={20} />
              </span>
              <h2>{feature.title}</h2>
              <p>{feature.body}</p>
            </article>
          ))}
        </section>

        {/*
          Stated plainly rather than buried in a policy page. It is the first
          question anyone sensible asks about an app that wants their mail,
          and the honest answer happens to be a good one.
        */}
        <section className="card promise">
          <h2>
            <ShieldIcon size={18} />
            What Hive does not do
          </h2>
          <ul>
            <li>
              <strong>It does not store your email.</strong> Subjects, senders
              and dates are indexed so search is fast. Message bodies are
              fetched from Gmail when you open them, and never saved.
            </li>
            <li>
              <strong>Deleting is deliberate.</strong> Bulk cleanup always goes
              to Trash, recoverable for thirty days. Permanent deletion exists,
              but only from the Trash view, one confirmation at a time — never
              on a schedule and never by accident.
            </li>
            <li>
              <strong>It has no ads and no third parties.</strong> Your data is
              never shared or sold, and nothing about your mail leaves Hive and
              Google.
            </li>
          </ul>
        </section>
      </main>

      <footer className="landing__foot">
        <button type="button" className="link" onClick={() => onLegal('privacy')}>
          Privacy
        </button>
        <button type="button" className="link" onClick={() => onLegal('terms')}>
          Terms
        </button>
      </footer>
    </div>
  )
}
