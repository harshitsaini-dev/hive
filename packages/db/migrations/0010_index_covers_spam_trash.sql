-- Records whether an index actually contains Spam and Trash.
--
-- It never did. The backfill lists messages with no query, and Gmail's
-- `messages.list` excludes SPAM and TRASH unless `includeSpamTrash` is set —
-- a gate in front of the results rather than a filter on them. So the index
-- held everything except those two folders while claiming to hold the lot,
-- and the Spam view, answered from it, showed "Nothing in Spam" beside a
-- Gmail tab listing nine messages.
--
-- The backfill asks for them now. Indexes built before it did are still
-- missing them, and there is no way to tell from the rows themselves — an
-- account with no spam and an account whose spam was never fetched look
-- identical. Hence a flag: set when a backfill completes with the fix in
-- place, and until then those two folders are answered from Gmail directly.
--
-- Deliberately not forcing a re-index. Rebuilding is hours of Gmail quota per
-- account to recover two folders that are perfectly readable without it.

ALTER TABLE sync_state ADD COLUMN covers_spam_trash INTEGER NOT NULL DEFAULT 0
    CHECK (covers_spam_trash IN (0, 1));
