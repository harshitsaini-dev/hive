-- Lets an analysis run on a schedule, unattended.
--
-- The point is the cost of a run: reading who sent a message takes one Gmail
-- request per message, so a large mailbox spends minutes and a real slice of
-- a per-minute quota producing one. Doing that at three in the morning and
-- having the answer waiting is strictly better than making someone sit and
-- watch a progress bar when they open the page.
--
-- **This can never delete anything.** A schedule only ever produces numbers;
-- the destructive half of the panel stays behind a human pressing Clear and
-- confirming. An automated irreversible action against a query written weeks
-- ago is the worst failure mode this project has available to it, and the
-- absence of any action column here is deliberate — see ADR 0002.

CREATE TABLE IF NOT EXISTS analysis_schedules (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    cadence      TEXT NOT NULL CHECK (cadence IN ('daily', 'weekly')),
    -- When to run, as minutes past midnight **UTC**, 0–1439.
    --
    -- Minutes rather than an hour, because half-hour timezones exist: 03:00
    -- in India is 21:30 UTC, which cannot be stored as a whole UTC hour
    -- without rounding — and rounding it drifts the schedule by an hour every
    -- time the page converts it back to show the user. The cron only fires
    -- hourly, so the extra precision buys no accuracy; it buys a value that
    -- round-trips unchanged.
    minute_utc   INTEGER NOT NULL CHECK (minute_utc BETWEEN 0 AND 1439),
    account_id   TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
    query        TEXT NOT NULL,
    scan_limit   INTEGER NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    last_run_at  TEXT
);
