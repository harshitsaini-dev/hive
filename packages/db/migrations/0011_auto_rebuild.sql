-- Lets a drifted index repair itself, at most once every few hours.
--
-- An index can grow and never shrink: a backfill only adds, and an
-- incremental pass only applies what Gmail's history feed reports since its
-- cursor. Mail deleted before that cursor existed — or while the first pass
-- was still running — stays indexed for good, which is how an account came to
-- report 21,538 messages for a mailbox holding roughly two thousand.
--
-- Rebuilding fixes it and is expensive: the whole mailbox is read again, and
-- searches fall back to asking Gmail directly until it finishes. So this is
-- **not** a rebuild on a timer. It is a check on a timer that rebuilds only
-- when the row count has drifted well past the mailbox's own total, and the
-- timestamp below is what stops a wrong guess doing it over and over.

ALTER TABLE sync_state ADD COLUMN last_rebuild_at TEXT;
