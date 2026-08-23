import { randomUUID } from 'node:crypto'

/**
 * Progress tracking for bulk mailbox actions.
 *
 * **Why polling and not a WebSocket.** The server does run one, but the
 * browser cannot reach it: Vercel proxies `/api` to Render and does not carry
 * WebSocket upgrades, so the page would have to open a cross-origin socket —
 * which a `SameSite=Lax` session cookie does not accompany. That is the same
 * trap the OAuth callback fell into. A job id plus a polled status endpoint
 * goes through the existing same-origin proxy and simply works.
 *
 * Jobs live in memory. On a single free instance that is fine; if the API is
 * ever scaled out, a poll could land on a process that has never heard of the
 * job, and this needs to move to the database.
 */

export type JobStatus = 'running' | 'done' | 'failed'

export interface Job {
  id: string
  ownerId: string
  action: 'trash' | 'restore' | 'delete_forever'
  total: number
  processed: number
  status: JobStatus
  /** Only set when status is 'failed'. Safe to show a user. */
  error: string | null
  startedAt: number
  finishedAt: number | null
}

const jobs = new Map<string, Job>()

/** How long a finished job stays readable before it is swept. */
const RETAIN_MS = 10 * 60_000
const SWEEP_MS = 60_000

const sweeper = setInterval(() => {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > RETAIN_MS) jobs.delete(id)
  }
}, SWEEP_MS)

// Never hold the process open just to run the sweeper.
sweeper.unref()

export function createJob(
  ownerId: string,
  action: Job['action'],
  total: number,
): Job {
  const job: Job = {
    id: randomUUID(),
    ownerId,
    action,
    total,
    processed: 0,
    status: 'running',
    error: null,
    startedAt: Date.now(),
    finishedAt: null,
  }

  jobs.set(job.id, job)
  return job
}

/**
 * Ownership is checked here rather than trusted to the caller, so a job id
 * alone cannot reveal what someone else is doing to their mailbox.
 */
export function getJob(ownerId: string, id: string): Job | null {
  const job = jobs.get(id)
  return job && job.ownerId === ownerId ? job : null
}

export function advanceJob(id: string, processed: number): void {
  const job = jobs.get(id)
  if (job) job.processed = processed
}

export function finishJob(id: string, error?: string): void {
  const job = jobs.get(id)
  if (!job) return

  job.status = error ? 'failed' : 'done'
  job.error = error ?? null
  job.finishedAt = Date.now()
  if (!error) job.processed = job.total
}

/** Test-only, so a suite can start from a clean slate. */
export function resetJobs(): void {
  jobs.clear()
}
