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
import { spawn, spawnSync } from 'node:child_process'
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
 *
 * `detached` puts the child in its own process group. The chain is
 * shell → npm → tsx → node, and killing only the shell orphans the rest: the
 * server keeps the port and this script never exits, which is exactly how it
 * hung CI the first time. Signalling the group takes the whole tree down.
 */
const detached = process.platform !== 'win32'

const server = spawn('npm run start --workspace @hive/server', {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
  detached,
})

server.stdout.on('data', (chunk) => process.stdout.write(chunk))
server.stderr.on('data', (chunk) => process.stderr.write(chunk))

let exited = null
server.on('exit', (code) => {
  exited = code
})

function stopServer() {
  if (exited !== null || server.pid === undefined) return

  try {
    if (detached) {
      // A negative PID signals the whole process group.
      process.kill(-server.pid, 'SIGKILL')
    } else {
      // Synchronous: process.exit() while an async spawn is still starting
      // trips a libuv assertion on Windows, and the kill never lands.
      spawnSync('taskkill', ['/PID', String(server.pid), '/T', '/F'], {
        stdio: 'ignore',
      })
    }
  } catch {
    // Already gone.
  }
}

/** Exits explicitly: leftover pipes would otherwise keep the loop alive. */
function finish(ok, message) {
  if (!ok) console.error(`\n✗ ${message}`)
  stopServer()
  process.exit(ok ? 0 : 1)
}

async function main() {
  const deadline = Date.now() + BOOT_TIMEOUT_MS
  let health = null

  while (Date.now() < deadline) {
    if (exited !== null) {
      finish(false, `the server exited with code ${exited} before answering`)
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
    finish(false, `no response from ${BASE}/health within ${BOOT_TIMEOUT_MS / 1000}s`)
  }

  if (health.env !== 'production') {
    finish(false, `expected env "production", got "${health.env}"`)
  }
  console.log('✓ boots and reports production')

  // The test-only helpers are never mounted outside development. If this ever
  // returns anything but 404, a deployed instance is handing out login codes.
  const leaked = await fetch(`${BASE}/auth/test/last-code?email=a@b.c`)
  if (leaked.status !== 404) {
    finish(false, `test-only route is reachable in production (status ${leaked.status})`)
  }
  console.log('✓ dev-only test routes are not mounted')

  // TLS is terminated by the platform, so the process itself must serve plain
  // HTTP — answering over http:// at all already proves this.
  console.log('✓ serves plain HTTP for the platform proxy')

  finish(true)
}

main().catch((error) => {
  finish(false, `unexpected failure: ${error}`)
})
