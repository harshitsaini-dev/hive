import { config } from './config.js'

/**
 * Login-code delivery.
 *
 * Without a Resend key the code is logged to the server console instead of
 * being sent. That is a deliberate development affordance — it means the whole
 * auth flow can be built and tested before any email provider exists — but it
 * would be a serious hole in production, so it refuses to fall back there.
 */
export async function sendOtpEmail(to: string, code: string): Promise<void> {
  if (!config.canSendEmail) {
    if (config.isProduction) {
      throw new Error(
        'RESEND_API_KEY is not configured — cannot deliver login codes.',
      )
    }

    console.log(
      `\n  ┌─ login code for ${to}\n  │  ${code}\n  └─ expires in 10 minutes (not emailed: RESEND_API_KEY unset)\n`,
    )
    return
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: config.OTP_FROM_ADDRESS,
      to,
      subject: `${code} is your Hive login code`,
      text: [
        `Your Hive login code is ${code}.`,
        '',
        'It expires in 10 minutes and can only be used once.',
        'If you did not request it, you can ignore this email.',
      ].join('\n'),
    }),
  })

  if (!response.ok) {
    // The body often explains exactly what is wrong — an unverified sending
    // domain being the usual answer — so it is worth keeping in the log.
    const detail = await response.text().catch(() => '')
    throw new Error(`Resend rejected the request (${response.status}): ${detail}`)
  }
}
