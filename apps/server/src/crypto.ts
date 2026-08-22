/**
 * Encryption for Gmail OAuth tokens at rest, and hashing for session tokens
 * and login codes.
 *
 * These values are the crown jewels of the project: a stolen refresh token is
 * standing access to someone's mailbox. Nothing here may ever be logged, and
 * the ciphertext format is versioned so the scheme can be changed later
 * without guessing at what old rows contain.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'
import { config } from './config.js'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12 // GCM standard
const VERSION = 'v1'

const key = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'base64')

/** Returns `v1.<iv>.<authTag>.<ciphertext>`, all base64url. */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    VERSION,
    iv.toString('base64url'),
    authTag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.')
}

export function decrypt(payload: string): string {
  const [version, iv, authTag, ciphertext] = payload.split('.')

  if (version !== VERSION || !iv || !authTag || !ciphertext) {
    throw new Error('Malformed ciphertext')
  }

  const decipher = createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(iv, 'base64url'),
  )
  decipher.setAuthTag(Buffer.from(authTag, 'base64url'))

  // GCM verifies the tag on final(); a wrong key or tampered row throws here
  // rather than returning garbage.
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8')
}

/**
 * Session tokens and OTP codes are stored hashed. They are high-entropy
 * random values rather than passwords, so a fast hash is appropriate — the
 * threat model is database disclosure, not offline cracking.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** Six digits, uniformly distributed — no modulo bias. */
export function randomOtpCode(): string {
  let digits = ''
  while (digits.length < 6) {
    for (const byte of randomBytes(6)) {
      if (byte < 250 && digits.length < 6) digits += String(byte % 10)
    }
  }
  return digits
}

/** Constant-time compare, for anything an attacker can submit repeatedly. */
export function safeEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a)
  const bufferB = Buffer.from(b)
  if (bufferA.length !== bufferB.length) return false
  return timingSafeEqual(bufferA, bufferB)
}
