/**
 * Works out what is in a mailbox, and who put it there.
 *
 * Lives outside the route because two callers need it: the panel, which asks
 * for a run and watches it, and the scheduler, which runs one unattended so
 * the answer is already waiting the next time someone signs in.
 *
 * **The two halves are priced completely differently, and that shapes the
 * whole design.** How many messages match, and how many carry a file, come
 * from lists of message ids — 500 an API call, so a hundred thousand of them
 * is a couple of hundred cheap calls and the numbers are exact. Working out
 * *who sent them* needs the `From` header of every single message, one
 * metadata read each, against a quota of roughly three thousand a minute. A
 * hundred thousand messages is therefore about half an hour of solid fetching
 * for the sender breakdown alone.
 *
 * So the run reads the newest slice up to `scanLimit` and reports exactly how
 * deep it got. The totals beside it are always for everything.
 */
import { listAccountsForOwner, saveAnalysisRun } from '@hive/db'
import { fetchMessagesMetadata, listAllMessageIds } from '@hive/gmail-client'
import { withGmail } from './gmail.js'

/**
 * Ceiling on the id listing behind the exact counts.
 *
 * Deliberately far above the bulk-action cap, which exists to limit the blast
 * radius of an *action*. Nothing is destroyed by counting, and reusing the
 * action cap here was a real bug: a hundred-thousand-message mailbox reported
 * a total of ten thousand — a wrong number presented as a fact.
 */
export const MAX_COUNT = 250_000

/** The deepest a sender scan may go, and the value meaning "all of them". */
export const MAX_SCAN = 250_000

export interface Tally {
  count: number
  withAttachment: number
}

export interface SenderTally extends Tally {
  address: string
  name: string
  /**
   * The same tally split by mailbox.
   *
   * Carried so the panel can narrow to one account without another run. The
   * expensive part of an analysis is reading a header per message; once that
   * is done, "who sent what, where" is arithmetic, and re-fetching it to
   * answer a question already in hand would spend minutes of quota twice.
   */
  byAccount: Record<string, Tally>
}

export interface AccountTally extends Tally {
  accountId: string
  gmailAddress: string
}

export interface MailboxAnalysis {
  total: number
  withAttachment: number
  withoutAttachment: number
  scanned: number
  truncated: boolean
  /** Per-mailbox totals, exact for the whole account like the figures above. */
  accounts: AccountTally[]
  senders: SenderTally[]
}

/** `"Kapil Gupta <kapil@example.com>"` -> both halves, separately useful. */
export function splitFrom(from: string): { name: string; address: string } {
  const withAngle = /^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/.exec(from)
  if (withAngle) {
    return {
      name: (withAngle[1] ?? '').trim(),
      address: (withAngle[2] ?? '').trim().toLowerCase(),
    }
  }

  const bare = from.trim().replace(/[<>]/g, '').toLowerCase()
  return { name: '', address: bare }
}

export async function runAnalysis(options: {
  userId: string
  /** One account, or every connected one when null. */
  accountId: string | null
  query: string
  scanLimit: number
  /** The UI control values behind the query. Opaque here; stored verbatim. */
  filters: Record<string, string>
  /** Reports how many headers have been read, and how many there are to read. */
  onProgress?: (done: number, total: number) => void
}): Promise<MailboxAnalysis> {
  const { userId, accountId, query, scanLimit, filters, onProgress } = options

  const accounts = (await listAccountsForOwner(userId)).filter(
    (account) => !accountId || account.id === accountId,
  )
  if (accounts.length === 0) throw new Error('No matching account')

  let total = 0
  let withAttachment = 0
  let scanned = 0
  let truncated = false
  const senders = new Map<string, SenderTally>()
  const perAccount: AccountTally[] = []

  for (const account of accounts) {
    await withGmail(userId, account.id, async (session) => {
      // Ids only: 500 per call, so this stays cheap at any size.
      const all = await listAllMessageIds(session.accessToken, query, MAX_COUNT)
      const attached = await listAllMessageIds(
        session.accessToken,
        `${query} has:attachment`,
        MAX_COUNT,
      )

      total += all.ids.length
      withAttachment += attached.ids.length
      if (all.truncated) truncated = true

      perAccount.push({
        accountId: account.id,
        gmailAddress: account.gmail_address,
        count: all.ids.length,
        withAttachment: attached.ids.length,
      })

      const attachedSet = new Set(attached.ids)
      const slice = all.ids.slice(0, scanLimit)
      if (slice.length < all.ids.length) truncated = true

      const before = scanned
      const metadata = await fetchMessagesMetadata(
        session.accessToken,
        slice,
        (done) => onProgress?.(before + done, before + slice.length),
      )

      for (const message of metadata) {
        const { name, address } = splitFrom(message.from)
        if (!address) continue

        const tally = senders.get(address) ?? {
          address,
          // The first non-empty display name wins; senders vary it.
          name: '',
          count: 0,
          withAttachment: 0,
          byAccount: {},
        }
        const hasFile = attachedSet.has(message.gmailMessageId)

        if (!tally.name && name) tally.name = name
        tally.count += 1
        if (hasFile) tally.withAttachment += 1

        const forAccount = tally.byAccount[account.id] ?? {
          count: 0,
          withAttachment: 0,
        }
        forAccount.count += 1
        if (hasFile) forAccount.withAttachment += 1
        tally.byAccount[account.id] = forAccount

        senders.set(address, tally)
      }

      scanned += slice.length
    })
  }

  const result: MailboxAnalysis = {
    total,
    withAttachment,
    withoutAttachment: Math.max(0, total - withAttachment),
    scanned,
    truncated,
    accounts: perAccount,
    // Ranked, and capped: a thousand rows of one message each is not a
    // finding, and the client would render every one of them.
    senders: [...senders.values()]
      .sort((a, b) => b.count - a.count)
      .slice(0, 200),
  }

  /*
   * Stored server-side, not in the browser. A run costs a Gmail request per
   * message, so it should still be there on whatever device the user signs in
   * from next — and a scheduled run has no browser to store it in at all.
   *
   * Counts and sender addresses only. Message content never reaches the
   * database; see the migration for the full note.
   */
  try {
    await saveAnalysisRun({ userId, accountId, query, filters, result })
  } catch (error) {
    /*
     * The run succeeded; only remembering it did not. Throwing here would
     * discard minutes of Gmail quota over a failed cache write — and report a
     * storage fault as if the analysis itself had failed, which is exactly
     * the misdirection that cost an afternoon after the table was added but
     * the migration had not been run against production.
     */
    console.error('could not store analysis run:', error)
  }

  return result
}
