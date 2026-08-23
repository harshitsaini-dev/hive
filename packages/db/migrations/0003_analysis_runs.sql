-- Stores the result of a mailbox analysis so it survives a reload, and shows
-- up on whatever device the user next signs in from.
--
-- It was in localStorage first, which met the "do not throw it away on
-- refresh" half of the requirement and none of the "see it from anywhere"
-- half. Worth persisting properly because a run is expensive: reading who
-- sent a message costs one Gmail request per message, so a large mailbox
-- spends a real slice of a scarce per-minute quota producing this.
--
-- **What is in `result_json`, and what is not.** Counts, sender addresses and
-- display names — the same metadata the mailbox list already shows, and
-- nothing more. No subjects, no snippets, no bodies, no attachments. The
-- privacy rule that message content never reaches this database is not
-- relaxed here; see docs/SELF-HOSTING.md and /privacy.
--
-- One row per user: the latest run replaces the one before it. Keeping a
-- history would mean growing this table without bound for a feature whose
-- whole point is "what does my mailbox look like now".

CREATE TABLE IF NOT EXISTS analysis_runs (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- The account the run was scoped to, or NULL for all of them. Nulled
    -- rather than cascaded away, so disconnecting an account leaves a result
    -- that is merely stale instead of vanishing mid-session.
    account_id   TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
    -- The Gmail query and the control values behind it, so the UI can restore
    -- the filters and notice when they have since drifted.
    query        TEXT NOT NULL,
    filters_json TEXT NOT NULL DEFAULT '{}',
    result_json  TEXT NOT NULL,
    finished_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
