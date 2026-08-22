/**
 * Starts the API exactly the way Render does and checks it answers.
 *
 * This exists because it has already gone wrong once: the workspace packages
 * export TypeScript source, so the compiled `node dist/index.js` start command
 * could not resolve them and the process died on boot. Typecheck and build
 * both passed — only actually running it caught the problem, and without this
 * the next place it would have surfaced is a failed deploy.
 *
 * Also asserts the dev-only test routes are absent, since NODE_ENV=production
 * is the only thing keeping them off a public instance.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = process.env.PORT ?? '3999'
const BASE = `http://localhost:${PORT}`
const BOOT_TIMEOUT_MS = 60_000

/*
 * One command string rather than an args array.
 *
 * Node 24 refuses to spawn a .cmd shim without a shell, so Windows needs
 * shell:true — but passing an args array alongside it is deprecated, because
 * the arguments get concatenated rather than escaped. A single literal string
 * avoids both. Nothing here is interpolated, so there is nothing to escape.
 */
const server = spawn('npm run start --workspace @hive/server', {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
})

let output = ''
server.stdout.on('data', (chunk) => {
  output += chunk
  process.stdout.write(chunk)
})
server.stderr.on('data', (chunk) => {
  output += chunk
  process.stderr.write(chunk)
})

let exited = null
server.on('exit', (code) => {
  exited = code
})

function fail(message) {
  console.error(`\n✗ ${message}`)
  server.kill('SIGTERM')
  process.exitCode = 1
}

async function main() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let health = null

  while (Date.now() < deadline) {
    if (exited !== null) {
      fail(`the server exited with code ${exited} before answering`)
      return
    }

    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) {
        health = await response.json()
        break
      }
    } catch {
      // Not listening yet.
    }

    await sleep(500)
  }

  if (!health) {
    fail(`no response from ${BASE}/health within ${BOOT_TIMEOUT_MS / 1000}s`)
    return
  }

  if (health.env !== 'production') {
    fail(`expected env "production", got "${health.env}"`)
    return
  }
  console.log('✓ boots and reports production')

  // The test-only helpers are never mounted outside development. If this ever
  // returns anything but 404, a deployed instance is handing out login codes.
  const leaked = await fetch(`${BASE}/auth/test/last-code?email=a@b.c`)
  if (leaked.status !== 404) {
    fail(`test-only route is reachable in production (status ${leaked.status})`)
    return
  }
  console.log('✓ dev-only test routes are not mounted')

  // TLS is terminated by the platform, so the process itself must serve plain
  // HTTP — that it answered over http:// at all already proves this.
  console.log('✓ serves plain HTTP for the platform proxy')

  server.kill('SIGTERM')
}

main()
  .catch((error) => {
    fail(`unexpected failure: ${error}`)
  })
  .finally(async () => {
    // Give the graceful-shutdown handler a moment before the process ends.
    await sleep(1000)
    server.kill('SIGKILL')
  })
