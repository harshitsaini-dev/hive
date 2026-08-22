/**
 * Environment parsing. Fails loudly at boot rather than at the first request —
 * a missing encryption key should stop the process, not surface as a 500 on
 * someone's login three hours later.
 */
import { config as loadEnv } from 'dotenv'
import { z } from 'zod'
import { resolve } from 'node:path'

loadEnv({ path: resolve(process.cwd(), '../../.env') })
loadEnv() // a local .env in the app dir wins, if present

/** 32 bytes, base64 — the length AES-256-GCM needs. */
const base64Key32 = z
  .string()
  .min(1)
  .refine(
    (value) => {
      try {
        return Buffer.from(value, 'base64').length === 32
      } catch {
        return false
      }
    },
    {
      message:
        'must be 32 bytes of base64 — generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    },
  )

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  WEB_ORIGIN: z.string().url().default('http://localhost:5173'),

  GOOGLE_CLIENT_ID: z
    .string()
    .min(1, 'GOOGLE_CLIENT_ID is required')
    // Pasting from the Cloud console sometimes carries a scheme or trailing
    // slash along with it, which Google rejects as an invalid client.
    .refine((v) => !v.includes('://') && !v.endsWith('/'), {
      message:
        'looks like a URL — use the bare client ID, e.g. 1234-abc.apps.googleusercontent.com',
    }),
  GOOGLE_CLIENT_SECRET: z.string().min(1, 'GOOGLE_CLIENT_SECRET is required'),
  GOOGLE_REDIRECT_URI: z.string().url(),

  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),
  OTP_FROM_ADDRESS: z.string().default('onboarding@resend.dev'),

  TOKEN_ENCRYPTION_KEY: base64Key32,
  SESSION_SECRET: base64Key32,
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
    .join('\n')
  console.error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`)
  process.exit(1)
}

export const config = Object.freeze({
  ...parsed.data,
  isProduction: parsed.data.NODE_ENV === 'production',
  /** OTPs cannot be delivered without Resend; routes should degrade clearly. */
  canSendEmail: Boolean(parsed.data.RESEND_API_KEY),
})

export type Config = typeof config
