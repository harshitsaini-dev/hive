/**
 * Fills the local message index and keeps it current.
 *
 * **Why this exists.** The Gmail API is cheap to count with and expensive to
 * read from: message ids come back 500 to a call, but learning the sender of
 * a message costs a metadata request each, against a quota of roughly three
 * thousand a minute. So "who sends me the most" — the one question the
 * analysis panel exists to answer — takes about half an hour on a
 * hundred-thousand-message mailbox, *every time it is asked*. Asked once and
 * stored, it is a `GROUP BY`.
 *
 * **Two phases, deliberately separate.**
 *
 * 1. *Backfill* walks the mailbox from newest to oldest, a page at a time,
 *    recording Gmail's own page token as it goes. It is designed to be
 *    interrupted — by a restart, a rate limit, a free instance spinning down
 *    — and to resume from where it stopped rather than starting again.
 * 2. *Incremental* applies `history.list` from a stored cursor. Only after
 *    the backfill completes: applying history to a half-filled index would
 *    leave holes that nothing would ever go back and fill.
 *
 * Gmail keeps about thirty days of history. Past that it answers 404, which
 * is not a failure but an instruction — drop the cursor and re-index. An
 * account that sat unreconnected for a month lands there, so it is a normal
 * path.
 *
 * **Metadata only.** Sender, subject, snippet, labels, date. Nothing here may
 * ever write a body or an attachment to the database; see CLAUDE.md.
 */
import {
  clearIndex,
  countIndexed,
  deleteIndexedMessages,
  getSyncState,
  listIndexedIds,
  markHasAttachment,
  updateSyncState,
  upsertMessages,
  type AccountRow,
} from '@hive/db'
import {
  fetchMessagesMetadata,
  getProfile,
  listHistory,
  listMessages,
} from '@hive/gmail-client'
import { withGmail } from './gmail.js'

/**
 * How many messages one pass will index before stopping and yielding.
 *
 * Not a limit on the mailbox — the next pass picks up the token and carries
 * on. It is a limit on how long one run holds the quota, so a backfill of a
 * huge mailbox cannot starve the interactive parts of the app for an hour.
 * Roughly a minute of Gmail's per-minute allowance.
 */
const PER_PASS = 2_000

/** Gmail's own page size for `messages.list`. */
const PAGE = 500

export interface SyncOutcome {
  indexed: number
  removed: number
  backfillDone: boolean
  /** True when the cursor had expired and the index was rebuilt from scratch. */
  reindexed: boolean
}

/**
 * Advances one account's index by at most one pass.
 *
 * Returns rather than loops: the caller decides whether to keep going, which
 * is what lets a scheduled sweep spread the work across every account instead
 * of finishing one and leaving the rest cold.
 */
/**
 * How often an index is checked against the mailbox it claims to describe.
 *
 * This replaced a heuristic that compared the number of indexed rows against
 * the mailbox's `messagesTotal` and rebuilt when it looked too high. That was
 * wrong in a way that could never settle: the index deliberately holds Spam
 * and Trash and `messagesTotal` does not count them, so an account with a
 * full bin was permanently "out of date" — the warning stayed after every
 * rebuild, and the rebuild ran again six hours later, for ever.
 *
 * Comparing ids instead of counts cannot be wrong in that way, because both
 * sides are the same question asked of the same mailbox.
 */
const RECONCILE_EVERY_MS = 6 * 60 * 60 * 1000

/**
 * Removes indexed messages that Gmail no longer has.
 *
 * Nothing else can. A backfill only adds; an incremental pass only applies
 * what the history feed reports since its cursor, and Gmail keeps about
 * thirty days of that. Mail deleted before the cursor existed — or while the
 * first pass was still running — stays indexed for good.
 *
 * Deliberately not a rebuild, which was the previous answer and cost far more
 * than the problem: ids come back 500 to a call and carry no metadata, so
 * checking a twenty-thousand-message mailbox is about forty cheap requests.
 * Re-reading it would be twenty thousand expensive ones.
 */
async function reconcile(
  accountId: string,
  accessToken: string,
): Promise<number> {
  const live = new Set<string>()
  let pageToken: string | undefined

  do {
    const page = await listMessages(accessToken, {
      pageToken,
      maxResults: PAGE,
      // The index covers them, so the comparison has to as well — this is
      // exactly the mismatch that made the old check unfixable.
      includeSpamTrash: true,
    })

    for (const ref of page.messages) live.add(ref.id)
    pageToken = page.nextPageToken
  } while (pageToken)

  const indexed = await listIndexedIds(accountId)
  const gone = indexed.filter((id) => !live.has(id))

  // In chunks: a delete lists every id in the statement, and SQLite has a
  // limit on how many variables one statement may carry.
  for (let i = 0; i < gone.length; i += 400) {
    await deleteIndexedMessages(accountId, gone.slice(i, i + 400))
  }

  await updateSyncState(accountId, {
    touchRebuilt: true,
    indexedCount: await countIndexed(accountId),
  })

  return gone.length
}

/** Whether this index is due a comparison against the mailbox itself. */
function dueReconcile(state: { last_rebuild_at: string | null }): boolean {
  if (!state.last_rebuild_at) return true

  const since = Date.now() - new Date(`${state.last_rebuild_at}Z`).getTime()
  return !Number.isFinite(since) || since >= RECONCILE_EVERY_MS
}

export async function syncAccount(
  ownerId: string,
  account: AccountRow,
): Promise<SyncOutcome> {
  try {
    const outcome = await withGmail(ownerId, account.id, async (session) => {
      const state = await getSyncState(account.id)

      /*
       * A completed index is compared against the mailbox every few hours,
       * and anything Gmail no longer has is dropped. This is the only thing
       * that can remove what the history feed never reported.
       */
      if (state?.backfill_done === 1 && dueReconcile(state)) {
        const removed = await reconcile(account.id, session.accessToken)
        if (removed > 0) {
          console.log(`reconciled ${account.id}: dropped ${removed}`)
        }
      }

      if (state?.backfill_done === 1) {
        // Complete but cursorless: the finishing step was interrupted. Take
        // the cursor now rather than rebuilding an index that is already
        // correct.
        if (!state.history_id) {
          await updateSyncState(account.id, {
            historyId: (await getProfile(session.accessToken)).historyId,
          })
          return {
            indexed: 0,
            removed: 0,
            backfillDone: true,
            reindexed: false,
          }
        }

        return incremental(account.id, session.accessToken, state.history_id)
      }

      return backfill(
        account.id,
        session.accessToken,
        state?.backfill_token ?? null,
      )
    })

    await updateSyncState(account.id, { lastError: null, touchSynced: true })
    return outcome
  } catch (error) {
    /*
     * Recorded rather than swallowed. An account that stopped syncing three
     * days ago should be able to say so — silence looks identical to "nothing
     * has changed", which is the wrong conclusion to leave someone with.
     */
    const message = error instanceof Error ? error.message : String(error)
    await updateSyncState(account.id, { lastError: message.slice(0, 300) })
    throw error
  }
}

/**
 * Brings an indexed mailbox up to the minute, cheaply, before it is read.
 *
 * The sweep runs hourly, which is fine for an analysis and not fine for an
 * inbox: a message that arrived four minutes ago has to be there. One
 * `history.list` call usually covers it, so serving a search from the index
 * costs one request rather than the five hundred a page of metadata does.
 *
 * Returns false when the index cannot answer — not backfilled, paused, or the
 * catch-up failed — and the caller should go to Gmail instead. Failing over
 * is always safe; the wrong answer is not.
 */
export async function freshenIndex(
  ownerId: string,
  account: AccountRow,
): Promise<boolean> {
  const state = await getSyncState(account.id)
  if (!state || state.backfill_done !== 1 || state.paused === 1) return false

  // Recently caught up. Re-asking on every keystroke would spend a request
  // per search for an answer that cannot have changed.
  if (state.last_synced_at) {
    const age = Date.now() - new Date(`${state.last_synced_at}Z`).getTime()
    if (Number.isFinite(age) && age < 60_000) return true
  }

  try {
    await withGmail(ownerId, account.id, async (session) => {
      if (!state.history_id) {
        await updateSyncState(account.id, {
          historyId: (await getProfile(session.accessToken)).historyId,
        })
        return
      }

      const outcome = await incremental(
        account.id,
        session.accessToken,
        state.history_id,
      )

      // The cursor expired and the index was thrown away; it cannot answer
      // anything until the backfill has run again.
      if (outcome.reindexed) throw new Error('index is rebuilding')
    })

    await updateSyncState(account.id, { touchSynced: true, lastError: null })
    return true
  } catch (error) {
    console.warn(`could not freshen index for ${account.id}:`, error)
    return false
  }
}

async function backfill(
  accountId: string,
  accessToken: string,
  token: string | null,
): Promise<SyncOutcome> {
  let pageToken = token ?? undefined
  let indexed = 0
  let done = false

  /*
   * The size of the mailbox, from the profile rather than from the listing.
   *
   * `messages.list` returns a `resultSizeEstimate` and it is not one: on a
   * mailbox of tens of thousands it came back as **501** — the page size plus
   * one — so the progress line read "26,829 of about 501". `messagesTotal` on
   * the profile is the real count, and it costs a single call.
   */
  if (!token) {
    try {
      const profile = await getProfile(accessToken)
      await updateSyncState(accountId, {
        totalEstimate: profile.messagesTotal || null,
      })
    } catch (error) {
      // A missing total is a missing progress bar, not a failed backfill.
      console.warn(`could not read the mailbox size for ${accountId}:`, error)
    }
  }

  while (indexed < PER_PASS) {
    const page = await listMessages(accessToken, {
      /*
       * No query, and Spam and Trash included.
       *
       * Both halves matter. The index is meant to be the whole mailbox so the
       * views built on it can exclude what they like — but Gmail's default is
       * to withhold those two folders, so for a long time the index quietly
       * held everything else and the Spam view read from it and found nothing.
       */
      pageToken,
      maxResults: PAGE,
      includeSpamTrash: true,
    })

    const ids = page.messages.map((ref) => ref.id)
    if (ids.length > 0) {
      const metadata = await fetchMessagesMetadata(accessToken, ids)

      await upsertMessages(
        accountId,
        metadata.map((message) => ({
          gmailMessageId: message.gmailMessageId,
          threadId: message.threadId,
          from: message.from,
          subject: message.subject,
          snippet: message.snippet,
          labels: message.labels,
          receivedAt: message.receivedAt.toISOString(),
        })),
      )

      indexed += metadata.length
    }


    pageToken = page.nextPageToken
    if (!pageToken) {
      done = true
      break
    }

    await updateSyncState(accountId, {
      backfillToken: pageToken,
      indexedCount: await countIndexed(accountId),
    })
  }

  if (done) {
    /*
     * Marked complete first, and the cursor fetched separately.
     *
     * These used to be one step, and the ordering lost entire backfills: the
     * final page leaves no page token, so a failure while fetching the cursor
     * meant the next pass found neither a token nor a completion flag and
     * started the whole mailbox again. Hours of work and quota, thrown away
     * by a request that had nothing to do with the index.
     *
     * The cursor is still taken *after* the pages rather than before them —
     * taken first, anything arriving during a backfill that ran for an hour
     * would fall between the two phases and never be indexed at all.
     */
    await updateSyncState(accountId, {
      backfillDone: true,
      backfillToken: null,
      // This pass asked for them, so the index genuinely holds them now.
      coversSpamTrash: true,
      indexedCount: await countIndexed(accountId),
    })

    try {
      await markAttachments(accountId, accessToken)
      await updateSyncState(accountId, {
        historyId: (await getProfile(accessToken)).historyId,
      })
    } catch (error) {
      /*
       * Both are recoverable on their own. Without a cursor the next pass
       * simply takes one; without the attachment pass the flags stay false
       * until the next full re-index. Neither is worth discarding a finished
       * index over.
       */
      console.warn(`finishing sync for ${accountId} was incomplete:`, error)
    }
  } else {
    await updateSyncState(accountId, {
      backfillToken: pageToken ?? null,
      indexedCount: await countIndexed(accountId),
    })
  }

  return { indexed, removed: 0, backfillDone: done, reindexed: false }
}

/**
 * Which indexed messages carry a file.
 *
 * A second pass rather than part of the first, because Gmail's metadata
 * format omits the MIME parts entirely — there is no way to tell from the
 * data the backfill already has. The `has:attachment` search knows, though,
 * and asking it costs an id list: 500 to a call, no metadata reads at all.
 */
async function markAttachments(
  accountId: string,
  accessToken: string,
): Promise<void> {
  let pageToken: string | undefined

  do {
    const page = await listMessages(accessToken, {
      query: 'has:attachment',
      pageToken,
      maxResults: PAGE,
      // The index covers Spam and Trash, so their attachments count too.
      includeSpamTrash: true,
    })

    await markHasAttachment(
      accountId,
      page.messages.map((ref) => ref.id),
    )

    pageToken = page.nextPageToken
  } while (pageToken)
}

async function incremental(
  accountId: string,
  accessToken: string,
  historyId: string,
): Promise<SyncOutcome> {
  const changes = await listHistory(accessToken, historyId)

  if (changes.expired) {
    /*
     * Past Gmail's ~30 day history window. Not an error: the only correct
     * response is to throw the index away and build it again, which the next
     * pass will start doing because `backfill_done` goes back to 0.
     */
    await clearIndex(accountId)
    await updateSyncState(accountId, {
      backfillDone: false,
      backfillToken: null,
      historyId: null,
      indexedCount: 0,
    })

    return { indexed: 0, removed: 0, backfillDone: false, reindexed: true }
  }

  const removedIds = [...new Set(changes.removed.map((ref) => ref.id))]

  /*
   * New arrivals and label changes are re-read the same way. A message moved
   * to Trash is not deleted — it swaps `INBOX` for `TRASH` — so treating a
   * label change as anything less than "fetch this again" leaves the index
   * showing mail in a folder it is no longer in.
   */
  const addedIds = [
    ...new Set([
      ...changes.added.map((ref) => ref.id),
      ...changes.changed.map((ref) => ref.id),
    ]),
  ].filter((id) => !removedIds.includes(id))

  if (addedIds.length > 0) {
    const metadata = await fetchMessagesMetadata(accessToken, addedIds)

    await upsertMessages(
      accountId,
      metadata.map((message) => ({
        gmailMessageId: message.gmailMessageId,
        threadId: message.threadId,
        from: message.from,
        subject: message.subject,
        snippet: message.snippet,
        labels: message.labels,
        receivedAt: message.receivedAt.toISOString(),
      })),
    )

    /*
     * New arrivals get the attachment question asked about them alone. The
     * query is scoped by id rather than re-running the whole mailbox sweep,
     * which would undo the point of an incremental update.
     */
    const withFiles = await listMessages(accessToken, {
      query: 'has:attachment newer_than:2d',
      maxResults: PAGE,
    })
    const arrived = new Set(addedIds)
    await markHasAttachment(
      accountId,
      withFiles.messages.map((ref) => ref.id).filter((id) => arrived.has(id)),
    )
  }

  await deleteIndexedMessages(accountId, removedIds)

  /*
   * The mailbox size is refreshed on every pass, not only at backfill time.
   *
   * It is one call, and it is what lets the UI notice an index that has
   * drifted: the history feed cannot report what happened before its cursor,
   * so an index can hold twenty thousand messages for a mailbox that now
   * holds two, and nothing in the index itself would ever say so.
   */
  let mailboxSize: number | null = null
  try {
    mailboxSize = (await getProfile(accessToken)).messagesTotal || null
  } catch {
    // A missing size is a missing hint, not a failed sync.
  }

  await updateSyncState(accountId, {
    historyId: changes.historyId ?? historyId,
    indexedCount: await countIndexed(accountId),
    ...(mailboxSize === null ? {} : { totalEstimate: mailboxSize }),
  })

  return {
    indexed: addedIds.length,
    removed: removedIds.length,
    backfillDone: true,
    reindexed: false,
  }
}
