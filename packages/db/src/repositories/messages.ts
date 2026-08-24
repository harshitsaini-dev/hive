import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

/**
 * The local message index, and the bookkeeping that fills it.
 *
 * **Metadata only, forever.** Sender, subject, Gmail's own short snippet,
 * labels, date. No bodies, no attachments — the privacy policy says message
 * content never reaches this database and this file is where that promise is
 * either kept or broken. See CLAUDE.md and /privacy.
 *
 * The index exists because of one asymmetry in the Gmail API: counting
 * matches is cheap, and learning anything about a message costs a request
 * each. Answering "who sends me the most" from Gmail means a metadata read
 * per message; answering it from here is a `GROUP BY`.
 */

export interface IndexedMessage {
  gmailMessageId: string
  threadId: string
  from: string
  subject: string
  snippet: string
  labels: string[]
  receivedAt: string
}

export interface SyncStateRow {
  account_id: string
  history_id: string | null
  backfill_token: string | null
  backfill_done: number
  indexed_count: number
  total_estimate: number | null
  last_error: string | null
  last_synced_at: string | null
  paused: number
  /** Whether the backfill that built this index included Spam and Trash. */
  covers_spam_trash: number
  updated_at: string
}

/**
 * Writes a page of messages, replacing any already there.
 *
 * Upsert rather than insert: a re-index, a resumed backfill and a history
 * update all legitimately revisit the same message, and the labels are the
 * part that changes — a message that has since been trashed must not keep its
 * old `INBOX` row.
 *
 * `has_attachment` is deliberately absent from the update: it is filled by a
 * separate pass, and clobbering it here would erase that work every time a
 * label changed.
 */
export async function upsertMessages(
  accountId: string,
  messages: readonly IndexedMessage[],
): Promise<void> {
  if (messages.length === 0) return

  await db().batch(
    messages.map((message) => ({
      sql: `INSERT INTO message_index
              (id, account_id, gmail_message_id, thread_id, from_addr,
               subject, snippet, labels_json, received_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(account_id, gmail_message_id) DO UPDATE SET
              thread_id   = excluded.thread_id,
              from_addr   = excluded.from_addr,
              subject     = excluded.subject,
              snippet     = excluded.snippet,
              labels_json = excluded.labels_json,
              received_at = excluded.received_at,
              indexed_at  = datetime('now')`,
      args: [
        randomUUID(),
        accountId,
        message.gmailMessageId,
        message.threadId,
        message.from,
        message.subject,
        message.snippet,
        JSON.stringify(message.labels),
        message.receivedAt,
      ],
    })),
    'write',
  )
}

/** Marks which of these messages carry a file. See the migration. */
export async function markHasAttachment(
  accountId: string,
  gmailMessageIds: readonly string[],
): Promise<void> {
  if (gmailMessageIds.length === 0) return

  const placeholders = gmailMessageIds.map(() => '?').join(',')
  await db().execute({
    sql: `UPDATE message_index SET has_attachment = 1
          WHERE account_id = ? AND gmail_message_id IN (${placeholders})`,
    args: [accountId, ...gmailMessageIds],
  })
}

export async function deleteIndexedMessages(
  accountId: string,
  gmailMessageIds: readonly string[],
): Promise<void> {
  if (gmailMessageIds.length === 0) return

  const placeholders = gmailMessageIds.map(() => '?').join(',')
  await db().execute({
    sql: `DELETE FROM message_index
          WHERE account_id = ? AND gmail_message_id IN (${placeholders})`,
    args: [accountId, ...gmailMessageIds],
  })
}

/** Everything for one account, for a re-index after an expired cursor. */
export async function clearIndex(accountId: string): Promise<void> {
  await db().execute({
    sql: 'DELETE FROM message_index WHERE account_id = ?',
    args: [accountId],
  })
}

export async function countIndexed(accountId: string): Promise<number> {
  const result = await db().execute({
    sql: 'SELECT COUNT(*) AS n FROM message_index WHERE account_id = ?',
    args: [accountId],
  })

  return Number(result.rows[0]?.n ?? 0)
}

export interface IndexedSenderTally {
  from_addr: string
  count: number
  with_attachment: number
}

/**
 * The sender rollup, straight from SQL.
 *
 * This is the payoff. The same answer from Gmail costs one metadata request
 * per message and takes half an hour on a large mailbox; here it is a grouped
 * scan of one indexed column.
 *
 * **It takes the same query as the page listing**, and that is not a tidiness
 * point. It used to take a bare account id and quietly count the entire
 * index: an analysis of Sent reported a total of 163 from Gmail beside a
 * sender list adding to thousands, because the totals honoured the folder and
 * the rollup did not. Two numbers on one screen, measuring different things,
 * with nothing to say so.
 */
export async function tallySendersFromIndex(
  query: IndexQuery,
  limit = 200,
): Promise<IndexedSenderTally[]> {
  const where = buildWhere(query)

  const result = await db().execute({
    sql: `SELECT from_addr,
                 COUNT(*) AS count,
                 SUM(has_attachment) AS with_attachment
          FROM message_index
          WHERE ${where.sql}
          GROUP BY from_addr
          ORDER BY count DESC
          LIMIT ?`,
    args: [...where.args, limit],
  })

  return result.rows.map((row) => ({
    from_addr: String(row.from_addr),
    count: Number(row.count),
    with_attachment: Number(row.with_attachment ?? 0),
  }))
}

/* ---- sync bookkeeping ---------------------------------------------------- */

export async function getSyncState(
  accountId: string,
): Promise<SyncStateRow | null> {
  const result = await db().execute({
    sql: 'SELECT * FROM sync_state WHERE account_id = ?',
    args: [accountId],
  })

  return (result.rows[0] as unknown as SyncStateRow | undefined) ?? null
}

export async function listSyncStates(
  accountIds: readonly string[],
): Promise<SyncStateRow[]> {
  if (accountIds.length === 0) return []

  const placeholders = accountIds.map(() => '?').join(',')
  const result = await db().execute({
    sql: `SELECT * FROM sync_state WHERE account_id IN (${placeholders})`,
    args: [...accountIds],
  })

  return result.rows as unknown as SyncStateRow[]
}

/**
 * Merges a partial update into the row, creating it if absent.
 *
 * Partial on purpose: a backfill step advances the token and the count and
 * must not touch the history cursor, while a history step does the reverse.
 * Writing whole rows would make each one silently undo the other.
 */
export async function updateSyncState(
  accountId: string,
  patch: {
    historyId?: string | null
    backfillToken?: string | null
    backfillDone?: boolean
    indexedCount?: number
    totalEstimate?: number | null
    lastError?: string | null
    coversSpamTrash?: boolean
    paused?: boolean
    touchSynced?: boolean
  },
): Promise<void> {
  await db().execute({
    sql: 'INSERT OR IGNORE INTO sync_state (account_id) VALUES (?)',
    args: [accountId],
  })

  const sets: string[] = []
  const args: (string | number | null)[] = []

  if (patch.historyId !== undefined) {
    sets.push('history_id = ?')
    args.push(patch.historyId)
  }
  if (patch.backfillToken !== undefined) {
    sets.push('backfill_token = ?')
    args.push(patch.backfillToken)
  }
  if (patch.backfillDone !== undefined) {
    sets.push('backfill_done = ?')
    args.push(patch.backfillDone ? 1 : 0)
  }
  if (patch.indexedCount !== undefined) {
    sets.push('indexed_count = ?')
    args.push(patch.indexedCount)
  }
  if (patch.totalEstimate !== undefined) {
    sets.push('total_estimate = ?')
    args.push(patch.totalEstimate)
  }
  if (patch.lastError !== undefined) {
    sets.push('last_error = ?')
    args.push(patch.lastError)
  }
  if (patch.coversSpamTrash !== undefined) {
    sets.push('covers_spam_trash = ?')
    args.push(patch.coversSpamTrash ? 1 : 0)
  }
  if (patch.paused !== undefined) {
    sets.push('paused = ?')
    args.push(patch.paused ? 1 : 0)
  }
  if (patch.touchSynced) sets.push("last_synced_at = datetime('now')")

  sets.push("updated_at = datetime('now')")
  args.push(accountId)

  await db().execute({
    sql: `UPDATE sync_state SET ${sets.join(', ')} WHERE account_id = ?`,
    args,
  })
}

/* ---- searching the index ------------------------------------------------- */

/**
 * The structural half of a mailbox search.
 *
 * Deliberately *not* free text. The index holds sender, subject and Gmail's
 * short snippet — not the body — so a term appearing only in the body of a
 * message would be missed. Silently returning fewer results is the exact
 * class of bug that has bitten this project twice already, so a text search
 * still goes to Gmail and only these structural filters are answered locally.
 */
export interface IndexQuery {
  accountId: string
  /** 'all' means everything outside Spam, Trash and Drafts, as Gmail's own
   *  search does. The named folders are exactly themselves. */
  folder: 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'all'
  from?: string
  /** Inclusive, `YYYY-MM-DD`. */
  after?: string
  /** Exclusive, `YYYY-MM-DD`. */
  before?: string
  /** Messages older than this many days. */
  olderThanDays?: number
  category?: string
  hasAttachment?: boolean
  unreadOnly?: boolean
}

export interface IndexedRow {
  gmail_message_id: string
  thread_id: string
  from_addr: string
  subject: string
  snippet: string
  labels_json: string
  received_at: string
}

/**
 * Builds the WHERE clause shared by the page query and the count.
 *
 * Labels are matched with `LIKE` against the stored JSON array. Crude, and
 * correct here because Gmail's label ids have no substring collisions —
 * `"INBOX"` with its quotes cannot match inside `"CATEGORY_PROMOTIONS"`. A
 * proper join table would be the answer if labels ever needed real querying.
 */
function buildWhere(query: IndexQuery): {
  sql: string
  args: (string | number)[]
} {
  const clauses = ['account_id = ?']
  const args: (string | number)[] = [query.accountId]

  /*
   * Trash, Spam and Drafts are each exactly themselves. Everything else is
   * "outside those three", which is the default a search gets in Gmail — an
   * unsent draft and a message Gmail already judged are answers to a
   * different question than "where is that email".
   */
  const PINNED: Record<string, string> = {
    trash: 'TRASH',
    spam: 'SPAM',
    drafts: 'DRAFT',
  }

  const pinned = PINNED[query.folder]
  if (pinned) {
    clauses.push(`labels_json LIKE '%"${pinned}"%'`)
  } else {
    clauses.push(`labels_json NOT LIKE '%"TRASH"%'`)
    clauses.push(`labels_json NOT LIKE '%"SPAM"%'`)
    clauses.push(`labels_json NOT LIKE '%"DRAFT"%'`)

    if (query.folder === 'inbox') clauses.push(`labels_json LIKE '%"INBOX"%'`)
    if (query.folder === 'sent') clauses.push(`labels_json LIKE '%"SENT"%'`)
  }

  if (query.from) {
    clauses.push('from_addr LIKE ?')
    args.push(`%${query.from}%`)
  }
  if (query.after) {
    clauses.push('received_at >= ?')
    args.push(query.after)
  }
  if (query.before) {
    clauses.push('received_at < ?')
    args.push(query.before)
  }
  if (query.olderThanDays) {
    clauses.push(`received_at < datetime('now', ?)`)
    args.push(`-${query.olderThanDays} days`)
  }
  if (query.category) {
    clauses.push('labels_json LIKE ?')
    args.push(`%"CATEGORY_${query.category.toUpperCase()}"%`)
  }
  if (query.hasAttachment) clauses.push('has_attachment = 1')
  if (query.unreadOnly) clauses.push(`labels_json LIKE '%"UNREAD"%'`)

  return { sql: clauses.join(' AND '), args }
}

/**
 * One page of results, newest first.
 *
 * Offset paging rather than a cursor. The rows are ordered by a column that
 * does not change, and a mailbox does not reshuffle underneath a reader the
 * way an activity feed does — so the failure mode offset paging is famous for
 * does not really arise here, and it buys a page number the caller can jump
 * to rather than a token it has to walk.
 */
export async function searchIndex(
  query: IndexQuery,
  options: { limit: number; offset: number },
): Promise<IndexedRow[]> {
  const where = buildWhere(query)

  const result = await db().execute({
    sql: `SELECT gmail_message_id, thread_id, from_addr, subject, snippet,
                 labels_json, received_at
          FROM message_index
          WHERE ${where.sql}
          ORDER BY received_at DESC
          LIMIT ? OFFSET ?`,
    args: [...where.args, options.limit, options.offset],
  })

  return result.rows as unknown as IndexedRow[]
}

/** The real total for the same query — the number the page is a slice of. */
export async function countIndexMatches(query: IndexQuery): Promise<number> {
  const where = buildWhere(query)

  const result = await db().execute({
    sql: `SELECT COUNT(*) AS n FROM message_index WHERE ${where.sql}`,
    args: where.args,
  })

  return Number(result.rows[0]?.n ?? 0)
}

/**
 * The indexed rows for a specific set of Gmail ids.
 *
 * The point is what it saves. A text search has to go to Gmail — the index
 * holds no message bodies to search, and never will. But Gmail's answer is a
 * list of *ids*, which is the cheap half: 500 to a call. The expensive half is
 * turning those ids into something displayable, one metadata request each.
 *
 * If the messages are already indexed, that second half is free. Same ids,
 * same order, same results — just hydrated from here instead of bought again
 * from Google.
 */
export async function getIndexedByIds(
  accountId: string,
  gmailMessageIds: readonly string[],
): Promise<IndexedRow[]> {
  if (gmailMessageIds.length === 0) return []

  const placeholders = gmailMessageIds.map(() => '?').join(',')
  const result = await db().execute({
    sql: `SELECT gmail_message_id, thread_id, from_addr, subject, snippet,
                 labels_json, received_at
          FROM message_index
          WHERE account_id = ? AND gmail_message_id IN (${placeholders})`,
    args: [accountId, ...gmailMessageIds],
  })

  return result.rows as unknown as IndexedRow[]
}

/**
 * Applies a label move to indexed rows, without re-reading them from Gmail.
 *
 * Used when Hive itself has just trashed or restored something: the outcome
 * is already known, so the index can be corrected directly rather than
 * waiting an hour for the next history pass to notice. Gmail's own version
 * overwrites these rows on that pass regardless, so any divergence is
 * temporary by construction.
 *
 * The labels are stored as a JSON array and rewritten as one. Fiddly, and
 * still the right shape: a join table would be three more queries per page
 * for a column nothing filters on except by substring.
 */
export async function moveIndexedLabels(
  accountId: string,
  gmailMessageIds: readonly string[],
  change: { add?: string; remove?: readonly string[] },
): Promise<void> {
  if (gmailMessageIds.length === 0) return

  const rows = await getIndexedByIds(accountId, gmailMessageIds)
  if (rows.length === 0) return

  await db().batch(
    rows.map((row) => {
      let labels: string[]
      try {
        const parsed: unknown = JSON.parse(row.labels_json)
        labels = Array.isArray(parsed) ? (parsed as string[]) : []
      } catch {
        labels = []
      }

      const next = labels.filter((label) => !change.remove?.includes(label))
      if (change.add && !next.includes(change.add)) next.push(change.add)

      return {
        sql: `UPDATE message_index SET labels_json = ?, indexed_at = datetime('now')
              WHERE account_id = ? AND gmail_message_id = ?`,
        args: [JSON.stringify(next), accountId, row.gmail_message_id],
      }
    }),
    'write',
  )
}

/**
 * The display name this mailbox last sent under, learned from its own mail.
 *
 * A fallback for when Gmail's `sendAs` settings give nothing back — which
 * leaves recipients seeing the local part of the address where a name should
 * be. Every message the user has ever sent carries the answer in its `From`
 * header, and those headers are already indexed, so this costs one query and
 * no permission Hive does not already have.
 *
 * Only messages Gmail itself labelled `SENT`, so it is genuinely their own
 * outgoing mail and not something addressed to them.
 */
export async function findSentDisplayName(
  accountId: string,
  emailAddress: string,
): Promise<string | null> {
  const result = await db().execute({
    sql: `SELECT from_addr FROM message_index
          WHERE account_id = ?
            AND labels_json LIKE '%"SENT"%'
            AND from_addr LIKE ?
          ORDER BY received_at DESC
          LIMIT 20`,
    args: [accountId, `%${emailAddress}%`],
  })

  for (const row of result.rows) {
    // `"Kapil Gupta" <k@x.com>` or `Kapil Gupta <k@x.com>`; a bare address has
    // no angle brackets and therefore nothing to learn from.
    const match = /^\s*"?([^"<]+?)"?\s*</.exec(String(row.from_addr))
    const name = match?.[1]?.trim()

    // A name that is just the address again teaches nothing.
    if (name && name.toLowerCase() !== emailAddress.toLowerCase()) return name
  }

  return null
}
