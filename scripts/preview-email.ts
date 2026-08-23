/**
 * Renders the login email to `.logs/otp-preview.html` so it can be opened in
 * a browser.
 *
 * A browser is not an email client, so this proves layout and colour, not
 * compatibility — Outlook in particular will differ. It is still the fastest
 * way to catch the obvious things without sending mail to yourself repeatedly.
 *
 *   npx tsx scripts/preview-email.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderOtpEmail, OTP_TTL_MINUTES } from '../apps/server/src/emails/otp.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, '.logs', 'otp-preview.html')

const email = renderOtpEmail('482913', OTP_TTL_MINUTES)

mkdirSync(join(root, '.logs'), { recursive: true })
writeFileSync(out, email.html)

console.log(`subject: ${email.subject}`)
console.log(`wrote ${out} (${email.html.length} bytes)`)
console.log('\n--- plain-text alternative ---')
console.log(email.text)
