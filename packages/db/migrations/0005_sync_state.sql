-- Turns message_index from an empty table into something worth reading.
--
-- Until now every search and every analysis went to Gmail. That is correct and
-- it is slow in one specific, expensive way: counting matches is cheap (ids
-- come back 500 an API call) but learning *anything about* a message costs a
-- metadata request each, against a quota of roughly 3,000 a minute. A
-- hundred-thousand-message mailbox therefore takes about half an hour to
-- answer "who sends me the most", every single time it is asked.
--
-- A local index answers that in milliseconds. What it costs is this table: the
-- bookkeeping needed to fill the index once and then keep it current without
-- starting over.

CREATE TABLE IF NOT EXISTS sync_state (
    account_id     TEXT PRIMARY KEY REFERENCES connected_accounts(id) ON DELETE CASCADE,

    -- Gmail's cursor for incremental updates. Null until the first backfill
    -- finishes — applying history to a half-filled index would leave gaps
    -- that nothing would ever go back and fix.
    history_id     TEXT,

    -- Where the initial backfill got to. Gmail's own page token, so a run
    -- interrupted by a restart, a rate limit or a closed laptop resumes
    -- instead of re-reading everything it already has.
    backfill_token TEXT,
    backfill_done  INTEGER NOT NULL DEFAULT 0 CHECK (backfill_done IN (0, 1)),

    -- Progress, purely so the UI can say something true about a job that can
    -- legitimately run for hours.
    indexed_count  INTEGER NOT NULL DEFAULT 0,
    total_estimate INTEGER,

    -- Set when a run fails. Kept rather than thrown away: an account that
    -- stopped syncing three days ago should say so, not look idle.
    last_error     TEXT,
    last_synced_at TEXT,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Whether a message carries a file cannot be read from message metadata —
-- Gmail's metadata format omits the MIME parts entirely. It comes instead
-- from a second, cheap id-only query (`has:attachment`), and this column is
-- where that answer is recorded so the analysis never has to ask again.
ALTER TABLE message_index ADD COLUMN has_attachment INTEGER NOT NULL DEFAULT 0;

-- The sender rollup is the whole point of the index: "group by sender, newest
-- first, for this account". Without this it is a full scan of every row.
CREATE INDEX IF NOT EXISTS idx_messages_sender
    ON message_index(account_id, from_addr);
