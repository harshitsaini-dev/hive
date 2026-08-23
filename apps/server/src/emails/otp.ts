/**
 * The login-code email.
 *
 * Written for email clients, not browsers, which means a set of constraints
 * that look like 2005 on purpose:
 *
 * - **Tables for layout.** Outlook renders through Word, which has no flexbox
 *   or grid and ignores most of `div` positioning.
 * - **Inline styles for anything load-bearing.** Gmail strips `<style>` blocks
 *   in several contexts, so the `<style>` here only carries progressive
 *   enhancement (dark mode) that is safe to lose.
 * - **No images.** Most clients block remote images by default, so a logo
 *   would usually render as a broken box — and a login email that looks broken
 *   is a login email people report as phishing. The mark is drawn with a
 *   border-radius instead.
 * - **A real plain-text alternative.** Not a courtesy: a message with no text
 *   part scores worse with spam filters, and this is the one email that must
 *   never land in spam.
 */

/**
 * How long a login code stays valid.
 *
 * Lives here because the email prints it and the route enforces it — if the
 * two ever disagree, the email is lying to the reader about their own code.
 */
export const OTP_TTL_MINUTES = 10

export interface OtpEmail {
  subject: string
  html: string
  text: string
}

const BRAND = {
  bg: '#f4efe4',
  surface: '#fbf7ee',
  ink: '#2b2620',
  muted: '#6b6357',
  accent: '#b8801d',
  border: '#e0d7c4',
  codeBg: '#ece5d6',
}

/** Splits 123456 into "123 456" — easier to read and to retype. */
function spaced(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

export function renderOtpEmail(code: string, expiresInMinutes: number): OtpEmail {
  const subject = `${code} is your Hive login code`

  /*
   * Preheader: the grey preview line clients show after the subject. Left
   * unset, they scrape the first visible text, which here would be the word
   * "Hive". Hidden from the body itself with the usual zero-size trick.
   */
  const preheader = `Use this code to sign in. It expires in ${expiresInMinutes} minutes.`

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <meta name="supported-color-schemes" content="light dark" />
    <title>${subject}</title>
    <style>
      /*
       * Dark mode, where supported (Apple Mail, Outlook for Mac, some others).
       * Gmail ignores this and shows the light version, which is why every
       * light colour is also set inline — the fallback has to stand alone.
       */
      @media (prefers-color-scheme: dark) {
        .bg { background: #14120f !important; }
        .card { background: #211d18 !important; border-color: #332d25 !important; }
        .ink { color: #f3eee4 !important; }
        .muted { color: #a89f92 !important; }
        .code-box { background: #1a1713 !important; border-color: #332d25 !important; }
        .code { color: #e0a53a !important; }
        .mark { background: #e0a53a !important; color: #241a05 !important; }
        .rule { border-top-color: #332d25 !important; }
      }

      @media (max-width: 480px) {
        .card { padding: 28px 22px !important; }
        .code { font-size: 30px !important; letter-spacing: 6px !important; }
      }
    </style>
  </head>

  <body class="bg" style="margin:0;padding:0;background:${BRAND.bg};">
    <div style="display:none;font-size:1px;color:${BRAND.bg};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${BRAND.bg};">
      <tr>
        <td align="center" style="padding:40px 16px;">

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">

            <!-- Wordmark -->
            <tr>
              <td align="center" style="padding-bottom:24px;">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="mark" style="width:30px;height:30px;background:${BRAND.accent};border-radius:9px;text-align:center;vertical-align:middle;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#ffffff;line-height:30px;">H</td>
                    <td class="ink" style="padding-left:10px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:${BRAND.ink};letter-spacing:-0.3px;">Hive</td>
                  </tr>
                </table>
              </td>
            </tr>

            <tr>
              <td class="card" style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:18px;padding:36px 32px;">

                <p class="ink" style="margin:0 0 8px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:19px;font-weight:600;color:${BRAND.ink};">
                  Your login code
                </p>

                <p class="muted" style="margin:0 0 26px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:23px;color:${BRAND.muted};">
                  Enter this to finish signing in to Hive.
                </p>

                <!-- The code. Selectable text, never an image: people copy it. -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td class="code-box" align="center" style="background:${BRAND.codeBg};border:1px solid ${BRAND.border};border-radius:12px;padding:22px 12px;">
                      <span class="code" style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:36px;font-weight:700;letter-spacing:8px;color:${BRAND.accent};">${spaced(code)}</span>
                    </td>
                  </tr>
                </table>

                <p class="muted" style="margin:22px 0 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:14px;line-height:22px;color:${BRAND.muted};">
                  It expires in ${expiresInMinutes} minutes and can only be used once.
                </p>

                <hr class="rule" style="border:0;border-top:1px solid ${BRAND.border};margin:26px 0;" />

                <p class="muted" style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:21px;color:${BRAND.muted};">
                  If you didn&rsquo;t ask to sign in, you can ignore this email &mdash;
                  nobody can get in without the code above. Hive will never ask
                  you for it.
                </p>

              </td>
            </tr>

            <tr>
              <td align="center" style="padding-top:22px;">
                <p class="muted" style="margin:0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:19px;color:${BRAND.muted};">
                  Hive &middot; manage several Gmail accounts from one place
                </p>
              </td>
            </tr>

          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

  const text = [
    'Your Hive login code',
    '',
    `    ${spaced(code)}`,
    '',
    `It expires in ${expiresInMinutes} minutes and can only be used once.`,
    '',
    "If you didn't ask to sign in, you can ignore this email — nobody can get",
    'in without the code above. Hive will never ask you for it.',
    '',
    '—',
    'Hive · manage several Gmail accounts from one place',
    'https://hive.harshitsaini.in',
  ].join('\n')

  return { subject, html, text }
}
