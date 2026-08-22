/**
 * The bridge between stored accounts and the Gmail client.
 *
 * Every route that talks to Gmail goes through `withGmail`, so token
 * decryption, refresh and `reauth_required` handling exist in one place rather
 * than being re-implemented (and eventually forgotten) per route.
 */
import {
  findAccountForOwner,
  markReauthRequired,
  updateAccountTokens,
  type AccountRow,
} from '@hive/db'
import {
  ensureFreshTokens,
  ReauthRequiredError,
  type OAuthConfig,
  type StoredTokens,
} from '@hive/gmail-client'
import { canPermanentlyDelete } from '@hive/shared-types'
import { config } from './config.js'
import { decrypt, encrypt } from './crypto.js'
import { HttpError, notFound } from './errors.js'

export const oauthConfig: OAuthConfig = {
  clientId: config.GOOGLE_CLIENT_ID,
  clientSecret: config.GOOGLE_CLIENT_SECRET,
  redirectUri: config.GOOGLE_REDIRECT_URI,
}

/** 409: the account is still there, but the user must re-consent. */
export const reauthRequired = (address: string) =>
  new HttpError(
    409,
    'reauth_required',
    `${address} needs reconnecting before Hive can use it again.`,
  )

/** 403: the account works, but this operation needs a scope it lacks. */
export const scopeMissing = () =>
  new HttpError(
    403,
    'scope_not_granted',
    'This account did not grant permission to delete mail permanently. Reconnect it and accept that permission.',
  )

export interface GmailSession {
  account: AccountRow
  accessToken: string
  /** Whether this connection may permanently delete. */
  canDeleteForever: boolean
}

/**
 * Loads an account, refreshes its token if needed, and runs `work`.
 *
 * A `ReauthRequiredError` from anywhere inside is converted into a stored
 * `reauth_required` status plus a 409, so the UI can prompt reconnection
 * instead of showing a generic failure.
 */
export async function withGmail<T>(
  ownerId: string,
  accountId: string,
  work: (session: GmailSession) => Promise<T>,
): Promise<T> {
  const account = await findAccountForOwner(ownerId, accountId)
  if (!account) throw notFound('No such connected account')

  let tokens: StoredTokens
  try {
    tokens = JSON.parse(decrypt(account.encrypted_oauth_tokens)) as StoredTokens
  } catch {
    // Unreadable ciphertext means TOKEN_ENCRYPTION_KEY changed. Recoverable
    // only by reconnecting, so present it as that rather than a 500.
    await markReauthRequired(account.id)
    throw reauthRequired(account.gmail_address)
  }

  try {
    const { tokens: fresh, refreshed } = await ensureFreshTokens(
      oauthConfig,
      tokens,
    )

    if (refreshed) {
      await updateAccountTokens(account.id, encrypt(JSON.stringify(fresh)))
    }

    return await work({
      account,
      accessToken: fresh.accessToken,
      canDeleteForever: canPermanentlyDelete(fresh.scope),
    })
  } catch (error) {
    if (error instanceof ReauthRequiredError) {
      await markReauthRequired(account.id)
      throw reauthRequired(account.gmail_address)
    }
    throw error
  }
}
