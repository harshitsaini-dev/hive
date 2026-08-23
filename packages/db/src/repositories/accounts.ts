import { randomUUID } from 'node:crypto'
import { db } from '../index.js'

export interface AccountRow {
  id: string
  owner_id: string
  gmail_address: string
  encrypted_oauth_tokens: string
  status: 'active' | 'reauth_required'
  history_id: string | null
  last_synced_at: string | null
  /** Overrides the name Gmail reports. Null means "ask Gmail". */
  display_name: string | null
  connected_at: string
}

/**
 * Reconnecting an already-connected address updates the tokens rather than
 * creating a duplicate — which is exactly what happens when a user resolves a
 * `reauth_required` account by connecting it again.
 */
export async function upsertAccount(params: {
  ownerId: string
  gmailAddress: string
  encryptedTokens: string
}): Promise<AccountRow> {
  const address = params.gmailAddress.trim().toLowerCase()

  await db().execute({
    sql: `INSERT INTO connected_accounts
            (id, owner_id, gmail_address, encrypted_oauth_tokens, status)
          VALUES (?, ?, ?, ?, 'active')
          ON CONFLICT(owner_id, gmail_address) DO UPDATE SET
            encrypted_oauth_tokens = excluded.encrypted_oauth_tokens,
            status = 'active'`,
    args: [randomUUID(), params.ownerId, address, params.encryptedTokens],
  })

  const account = await findAccountByAddress(params.ownerId, address)
  if (!account) throw new Error(`Failed to upsert account ${address}`)
  return account
}

export async function findAccountByAddress(
  ownerId: string,
  gmailAddress: string,
): Promise<AccountRow | null> {
  const result = await db().execute({
    sql: `SELECT * FROM connected_accounts
          WHERE owner_id = ? AND gmail_address = ?`,
    args: [ownerId, gmailAddress.trim().toLowerCase()],
  })
  return (result.rows[0] as unknown as AccountRow) ?? null
}

/**
 * Ownership is part of the WHERE clause, not a check the caller is trusted to
 * remember. A route that only has an account ID cannot accidentally read
 * someone else's row.
 */
export async function findAccountForOwner(
  ownerId: string,
  accountId: string,
): Promise<AccountRow | null> {
  const result = await db().execute({
    sql: 'SELECT * FROM connected_accounts WHERE id = ? AND owner_id = ?',
    args: [accountId, ownerId],
  })
  return (result.rows[0] as unknown as AccountRow) ?? null
}

export async function listAccountsForOwner(
  ownerId: string,
): Promise<AccountRow[]> {
  const result = await db().execute({
    sql: `SELECT * FROM connected_accounts
          WHERE owner_id = ?
          ORDER BY connected_at ASC`,
    args: [ownerId],
  })
  return result.rows as unknown as AccountRow[]
}

/**
 * Every mailbox the scheduler should be keeping current, across all users.
 *
 * `reauth_required` accounts are excluded: their tokens are dead, so a sweep
 * would produce nothing but a failure per tick and a log full of noise. They
 * come back on their own once reconnected.
 */
export async function listAllActiveAccounts(): Promise<AccountRow[]> {
  const result = await db().execute(
    `SELECT * FROM connected_accounts
     WHERE status = 'active'
     ORDER BY connected_at ASC`,
  )
  return result.rows as unknown as AccountRow[]
}

export async function updateAccountTokens(
  accountId: string,
  encryptedTokens: string,
): Promise<void> {
  await db().execute({
    sql: `UPDATE connected_accounts
          SET encrypted_oauth_tokens = ?, status = 'active'
          WHERE id = ?`,
    args: [encryptedTokens, accountId],
  })
}

/**
 * Set when Google rejects the stored refresh token. Expected rather than
 * exceptional while the app is unverified — Testing-mode tokens expire after
 * seven days.
 */
export async function markReauthRequired(accountId: string): Promise<void> {
  await db().execute({
    sql: `UPDATE connected_accounts SET status = 'reauth_required' WHERE id = ?`,
    args: [accountId],
  })
}

export async function deleteAccount(
  ownerId: string,
  accountId: string,
): Promise<boolean> {
  const result = await db().execute({
    sql: 'DELETE FROM connected_accounts WHERE id = ? AND owner_id = ?',
    args: [accountId, ownerId],
  })
  return result.rowsAffected === 1
}

/**
 * The name mail from this account is sent under, when Hive has been told one.
 *
 * Null means "ask Gmail", which is the default and usually right. It exists
 * because "usually" is not "always": an alias with no display name makes
 * Gmail fall back to the local part of the address, and recipients see
 * `harshitsaini.dev` instead of a person.
 */
export async function setAccountDisplayName(
  accountId: string,
  displayName: string | null,
): Promise<void> {
  await db().execute({
    sql: 'UPDATE connected_accounts SET display_name = ? WHERE id = ?',
    args: [displayName, accountId],
  })
}
