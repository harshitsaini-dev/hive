import { ArrowLeftIcon, HiveMark } from './Icons.js'
import { ThemeToggle } from './ThemeToggle.js'

export type LegalKind = 'privacy' | 'terms'

/**
 * Last substantive change. Shown so a reader can tell whether the terms they
 * agreed to are the ones on screen — bump it whenever the wording changes in
 * a way that affects what Hive does with someone's data.
 */
const UPDATED = '22 August 2026'

/**
 * Privacy policy and terms.
 *
 * Google's OAuth verification reviewers read these pages, and so do users
 * deciding whether to hand over mailbox access. They must describe what the
 * code actually does — CLAUDE.md makes keeping them accurate a hard rule.
 * Anything claimed here has a corresponding guarantee in the implementation.
 */
export function LegalPage({
  kind,
  onBack,
}: {
  kind: LegalKind
  onBack: () => void
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
          <button type="button" className="link icon-btn" onClick={onBack}>
            <ArrowLeftIcon size={15} />
            Back
          </button>
        </div>
      </header>

      <main className="shell legal">
        {kind === 'privacy' ? <Privacy /> : <Terms />}
      </main>
    </div>
  )
}

function Privacy() {
  return (
    <>
      <h1>Privacy</h1>
      <p className="hint">Last updated {UPDATED}</p>

      <h2>The short version</h2>
      <p>
        Hive reads your Gmail so you can search and clean it. It stores enough
        about each message to make search fast, and nothing more. It does not
        keep the contents of your email, does not show ads, and does not share
        or sell anything to anyone.
      </p>

      <h2>What Hive stores</h2>
      <ul>
        <li>
          <strong>Your account:</strong> the email address you sign in with, and
          a session record so you stay signed in. Login codes are stored hashed
          and expire after ten minutes.
        </li>
        <li>
          <strong>Connected mailboxes:</strong> the Gmail address, your name
          as Google records it — used only as the sender name on mail you send
          — and Google access credentials encrypted with AES-256-GCM.
          Credentials are never written to logs.
        </li>
        <li>
          <strong>A message index:</strong> sender, subject, date, labels,
          Gmail&rsquo;s own short preview snippet, whether the message carries
          an attachment, and its message ID — so answering &ldquo;who sends me
          the most&rdquo; does not mean asking Google about every message in
          the mailbox one at a time. Deleting a mailbox from Hive deletes its
          index with it.
        </li>
        <li>
          <strong>Your last mailbox analysis:</strong> how many messages
          matched, how many carried an attachment, and a ranked list of sender
          addresses with their counts. Kept so the result is there when you
          sign in from somewhere else, and replaced each time you run it. No
          subjects, no snippets, no message content.
        </li>
        <li>
          <strong>An activity log:</strong> what Hive did and when — connected,
          disconnected, trashed, restored, deleted, sent, or ran a rule —
          including counts and recipient addresses, but never message content.
        </li>
      </ul>

      <h2>What Hive does not store</h2>
      <p>
        <strong>Message bodies and attachments are never saved.</strong> When
        you open a message, Hive fetches it from Gmail at that moment and
        discards it afterwards. Indexing deliberately requests metadata only, so
        bodies are not even transferred during a sync.
      </p>

      <h2>Permissions, and why each one</h2>
      <ul>
        <li>
          <code>gmail.readonly</code> — reading messages and search results.
        </li>
        <li>
          <code>gmail.modify</code> — moving messages to Trash and back out
          again. This is what bulk cleanup and cleanup rules use.
        </li>
        <li>
          <code>gmail.send</code> — sending the messages you compose.
        </li>
        <li>
          <code>userinfo.profile</code> — your name, so mail you send through
          Hive arrives from a person rather than a bare address. Nothing else
          about your Google profile is read or stored.
        </li>
        <li>
          <code>https://mail.google.com/</code> — permanently deleting messages
          from the Trash view. This is a broad permission, and it is requested
          only because permanent deletion cannot be done without it. Hive uses
          it in exactly one place: an explicit delete you confirm by typing.
        </li>
      </ul>

      <h2>Deleting things</h2>
      <p>
        Bulk cleanup and cleanup rules always move mail to Gmail&rsquo;s Trash,
        where it stays recoverable for thirty days. Permanent deletion is a
        separate action, available only from the Trash view, and it requires
        typing a confirmation phrase. It cannot be scheduled, cannot be
        triggered in bulk from a search, and cannot be undone by anyone —
        including us.
      </p>

      <h2>Who else is involved</h2>
      <p>
        Hive is not sold, rented or shared with anyone. It relies on three
        providers to function: <strong>Google</strong>, for the mail itself;
        <strong> Turso</strong>, which hosts the database described above; and
        <strong> Resend</strong>, which delivers your login codes and therefore
        sees the address the code is sent to. There is no analytics, tracking or
        advertising of any kind.
      </p>

      <h2>Removing your data</h2>
      <p>
        Disconnecting a mailbox deletes its stored credentials and its message
        index immediately. Revoking Hive&rsquo;s access from your{' '}
        <span className="nowrap">Google Account</span> permissions page has the
        same effect from Google&rsquo;s side. To remove your Hive account
        entirely, ask and it will be deleted along with everything listed above.
      </p>

      <h2>Changes</h2>
      <p>
        If what Hive does with your data changes, this page changes with it and
        the date at the top moves. It is not permitted, by the project&rsquo;s
        own rules, for this page to describe something the code does not do.
      </p>
    </>
  )
}

function Terms() {
  return (
    <>
      <h1>Terms of use</h1>
      <p className="hint">Last updated {UPDATED}</p>

      <h2>What this is</h2>
      <p>
        Hive is a free tool for managing your own Gmail accounts. By connecting
        an account you confirm you are entitled to access that mailbox.
      </p>

      <h2>Deletion is your responsibility</h2>
      <p>
        Hive can permanently delete email. That action is irreversible: deleted
        messages do not go to Trash and cannot be recovered by us, by you, or by
        Google. Hive asks you to confirm by typing before it does this, and
        shows you the exact number of messages involved. Beyond that, what you
        choose to delete is your decision.
      </p>
      <p>
        Cleanup rules only ever move mail to Trash, never delete it permanently.
        A rule still acts on whatever its search matches, so check what a search
        returns before saving it as a rule.
      </p>

      <h2>Availability</h2>
      <p>
        This is a free service run on free infrastructure. It may be slow,
        temporarily unavailable, or discontinued. It is provided as-is, without
        warranty of any kind, and it is not a backup of your email — Gmail
        remains the system of record.
      </p>

      <h2>Fair use</h2>
      <p>
        Do not use Hive to send unsolicited bulk email, to access a mailbox you
        do not have permission to access, or in a way that breaks{' '}
        <span className="nowrap">Google&rsquo;s</span> own terms. Gmail enforces
        its own daily sending limits and Hive does not raise them.
      </p>

      <h2>Your account</h2>
      <p>
        You can disconnect a mailbox or stop using Hive whenever you like; see
        the privacy page for what happens to stored data. Accounts that are used
        to abuse the service may be removed.
      </p>

      <h2>The software itself</h2>
      <p>
        Hive is open source under the MIT licence. These terms cover the hosted
        service. If you run your own copy, they do not apply to you — you are
        responsible for your own deployment, including any permissions you
        choose to request.
      </p>
    </>
  )
}
