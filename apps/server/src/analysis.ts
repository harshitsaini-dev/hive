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
import {
  getSyncState,
  listAccountsForOwner,
  saveAnalysisRun,
  tallySendersFromIndex,
  type IndexQuery,
} from '@hive/db'
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
  /**
   * The same scope, in the shape the index can query.
   *
   * Required rather than optional: the rollup used to take a bare account id
   * and count the whole index, so an analysis of Sent showed a total of 163
   * beside a sender list adding to thousands. Making the caller state the
   * scope is what stops the two halves measuring different things.
   */
  scope: IndexQuery
  /** Reports how many headers have been read, and how many there are to read. */
  onProgress?: (done: number, total: number) => void
}): Promise<MailboxAnalysis> {
  const { userId, accountId, query, scanLimit, filters, scope, onProgress } =
    options

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
  /** How many mailboxes answered from the index rather than from Gmail. */
  let indexedAccounts = 0

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

      /*
       * The local index, when it has this mailbox.
       *
       * This is the whole reason the index exists. The same rollup from Gmail
       * costs one metadata request per message — half an hour on a
       * hundred-thousand-message mailbox, every time it is asked. From here
       * it is a grouped scan, and the scan depth stops mattering because
       * nothing is being sampled.
       */
      const state = await getSyncState(account.id)

      /*
       * Spam and Trash only from an index built with them. Gmail withholds
       * both unless asked, and for a long time the backfill did not — so an
       * older index holds everything except those two while looking complete.
       */
      const folderMissing =
        (scope.folder === 'spam' || scope.folder === 'trash') &&
        state?.covers_spam_trash !== 1

      if (state?.backfill_done === 1 && !folderMissing) {
        const rows = await tallySendersFromIndex({
          ...scope,
          accountId: account.id,
        })

        for (const row of rows) {
          const { name, address } = splitFrom(row.from_addr)
          if (!address) continue

          const tally = senders.get(address) ?? {
            address,
            name: '',
            count: 0,
            withAttachment: 0,
            byAccount: {},
          }
          if (!tally.name && name) tally.name = name
          tally.count += row.count
          tally.withAttachment += row.with_attachment

          const forAccount = tally.byAccount[account.id] ?? {
            count: 0,
            withAttachment: 0,
          }
          forAccount.count += row.count
          forAccount.withAttachment += row.with_attachment
          tally.byAccount[account.id] = forAccount

          senders.set(address, tally)
        }

        // Nothing was sampled, so nothing about the senders is truncated.
        scanned += all.ids.length
        indexedAccounts += 1
        onProgress?.(scanned, scanned)
        return
      }

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

  const ranked = [...senders.values()].sort((a, b) => b.count - a.count)

  const result: MailboxAnalysis = {
    total,
    withAttachment,
    withoutAttachment: Math.max(0, total - withAttachment),
    scanned,
    // An indexed mailbox is not sampled, so the sender list is not a slice of
    // it — saying otherwise would understate an answer that is complete.
    truncated: indexedAccounts === accounts.length ? false : truncated,
    accounts: perAccount,
    /*
     * Every sender, ranked. There was a cap — two hundred, then five thousand
     * — and both hid the long tail that the list is most often opened to
     * find. The panel draws a hundred rows at a time and searches across all
     * of them, so the size of this array is not what anyone reads.
     *
     * The one real bound left is storage: the run is kept as a single row, so
     * an enormous result may fail to save. That is caught and logged, and
     * costs a cached copy rather than the answer itself.
     */
    senders: ranked,
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
