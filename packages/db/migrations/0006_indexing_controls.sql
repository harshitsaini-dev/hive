-- Replaces scheduled analysis with control over indexing.
--
-- Scheduling an analysis made sense while every run meant a metadata request
-- per message and therefore minutes of waiting: doing it at 3am and reading
-- the answer in the morning was strictly better. The local index removed the
-- reason. A run against an indexed mailbox is a grouped scan that finishes
-- immediately, so there is nothing left worth scheduling — what wants keeping
-- current is the index itself, and the hourly sweep already does that.
--
-- The table goes rather than lingering unused. A settings table nobody writes
-- to is a trap for whoever next reads the schema and assumes it means
-- something.

DROP TABLE IF EXISTS analysis_schedules;

-- Indexing is on by default and can be turned off per mailbox. Someone who
-- connected an account only to send from it should not be paying a background
-- sweep for a search they will never run.
ALTER TABLE sync_state ADD COLUMN paused INTEGER NOT NULL DEFAULT 0
    CHECK (paused IN (0, 1));
