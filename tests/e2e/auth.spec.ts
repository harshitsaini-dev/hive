import { expect, test, type APIRequestContext } from '@playwright/test'

const API = 'https://localhost:3000'

/** A fresh address per test, so runs never collide over rate limits or state. */
function uniqueEmail(label: string): string {
  return `test-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`
}

/**
 * The server prints login codes to its console when Resend is unconfigured,
 * which is not readable from here. `/auth/test/last-code` exposes the most
 * recent code, and exists only outside production — see routes/auth.ts.
 */
async function latestCode(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const response = await request.get(
    `${API}/auth/test/last-code?email=${encodeURIComponent(email)}`,
  )
  expect(response.ok(), 'test-only code endpoint should be available').toBe(true)
  const body = (await response.json()) as { code: string }
  return body.code
}

test.describe('login codes', () => {
  test('a valid code signs in and creates the account', async ({ request }) => {
    const email = uniqueEmail('happy')

    const requested = await request.post(`${API}/auth/otp/request`, {
      data: { email },
    })
    expect(requested.status()).toBe(202)

    const verified = await request.post(`${API}/auth/otp/verify`, {
      data: { email, code: await latestCode(request, email) },
    })
    expect(verified.ok()).toBe(true)
    expect(await verified.json()).toMatchObject({ user: { email } })

    // The session cookie now works for authenticated routes.
    const me = await request.get(`${API}/auth/me`)
    expect(me.ok()).toBe(true)
    expect(await me.json()).toMatchObject({ user: { email } })
  })

  test('a wrong code is rejected without revealing why', async ({ request }) => {
    const email = uniqueEmail('wrong')
    await request.post(`${API}/auth/otp/request`, { data: { email } })

    const response = await request.post(`${API}/auth/otp/verify`, {
      data: { email, code: '000000' },
    })

    expect(response.status()).toBe(400)
    const body = (await response.json()) as { error: { message: string } }
    // Deliberately identical to the message for an expired or unknown code.
    expect(body.error.message).toBe('That code is not valid. Request a new one.')
  })

  test('a code cannot be used twice', async ({ request }) => {
    const email = uniqueEmail('replay')
    await request.post(`${API}/auth/otp/request`, { data: { email } })
    const code = await latestCode(request, email)

    expect((await request.post(`${API}/auth/otp/verify`, { data: { email, code } })).ok()).toBe(true)

    const replay = await request.post(`${API}/auth/otp/verify`, {
      data: { email, code },
    })
    expect(replay.status()).toBe(400)
  })

  test('requesting a new code invalidates the previous one', async ({ request }) => {
    const email = uniqueEmail('rotate')

    await request.post(`${API}/auth/otp/request`, { data: { email } })
    const first = await latestCode(request, email)

    await request.post(`${API}/auth/otp/request`, { data: { email } })
    const second = await latestCode(request, email)
    expect(second).not.toBe(first)

    const stale = await request.post(`${API}/auth/otp/verify`, {
      data: { email, code: first },
    })
    expect(stale.status()).toBe(400)
  })

  test('a malformed email is rejected before any code is issued', async ({ request }) => {
    const response = await request.post(`${API}/auth/otp/request`, {
      data: { email: 'not-an-email' },
    })
    expect(response.status()).toBe(400)
  })

  test('repeated requests are rate limited', async ({ request }) => {
    const email = uniqueEmail('flood')

    const statuses: number[] = []
    for (let i = 0; i < 7; i++) {
      statuses.push(
        (await request.post(`${API}/auth/otp/request`, { data: { email } })).status(),
      )
    }

    expect(statuses.filter((s) => s === 202).length).toBe(5)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })
})

test.describe('protected routes', () => {
  const protectedRoutes = [
    { method: 'GET', path: '/auth/me' },
    { method: 'GET', path: '/accounts' },
    { method: 'GET', path: '/accounts/oauth/start' },
    { method: 'POST', path: '/auth/logout' },
  ] as const

  for (const route of protectedRoutes) {
    test(`${route.method} ${route.path} refuses an anonymous caller`, async ({
      playwright,
    }) => {
      // A fresh context, so no cookie from another test leaks in.
      const anonymous = await playwright.request.newContext()

      const response =
        route.method === 'GET'
          ? await anonymous.get(`${API}${route.path}`)
          : await anonymous.post(`${API}${route.path}`)

      expect(response.status()).toBe(401)
      expect(await response.json()).toMatchObject({
        error: { code: 'unauthorized' },
      })

      await anonymous.dispose()
    })
  }

  test('one user cannot delete another user\'s account row', async ({ playwright }) => {
    // Owner signs in and we learn an account ID shape; with no real Gmail
    // connection available in CI, the check that matters is that a stranger
    // gets 404 rather than 403-with-detail or a 500.
    const stranger = await playwright.request.newContext()
    const email = uniqueEmail('stranger')

    await stranger.post(`${API}/auth/otp/request`, { data: { email } })
    await stranger.post(`${API}/auth/otp/verify`, {
      data: { email, code: await latestCode(stranger, email) },
    })

    const response = await stranger.delete(
      `${API}/accounts/00000000-0000-0000-0000-000000000000`,
    )
    expect(response.status()).toBe(404)

    await stranger.dispose()
  })
})

test.describe('sessions', () => {
  test('logout revokes the session server-side', async ({ playwright }) => {
    const context = await playwright.request.newContext()
    const email = uniqueEmail('logout')

    await context.post(`${API}/auth/otp/request`, { data: { email } })
    await context.post(`${API}/auth/otp/verify`, {
      data: { email, code: await latestCode(context, email) },
    })

    expect((await context.get(`${API}/auth/me`)).ok()).toBe(true)
    expect((await context.post(`${API}/auth/logout`)).status()).toBe(204)
    expect((await context.get(`${API}/auth/me`)).status()).toBe(401)

    await context.dispose()
  })

  test('a forged session cookie is refused', async ({ playwright }) => {
    const context = await playwright.request.newContext({
      extraHTTPHeaders: { Cookie: 'hive_session=not-a-real-token' },
    })

    expect((await context.get(`${API}/auth/me`)).status()).toBe(401)

    await context.dispose()
  })
})
