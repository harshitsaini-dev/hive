-- Adds 'restore' and 'delete_forever' to the audit actions.
--
-- Permanent deletion is irreversible (ADR 0002), so its audit row is the only
-- record that will ever exist of what was destroyed. That makes widening this
-- constraint a prerequisite for the feature, not a tidy-up.
--
-- SQLite cannot ALTER a CHECK constraint, so the table is rebuilt. Done inside
-- the migration runner's batch, which rolls back as a unit if anything fails.

CREATE TABLE audit_log_new (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id    TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
    action        TEXT NOT NULL
                  CHECK (action IN (
                      'connect', 'disconnect', 'trash', 'restore',
                      'delete_forever', 'send', 'rule_run'
                  )),
    details_json  TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO audit_log_new (id, user_id, account_id, action, details_json, created_at)
SELECT id, user_id, account_id, action, details_json, created_at FROM audit_log;

DROP TABLE audit_log;

ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_log(user_id, created_at DESC);
