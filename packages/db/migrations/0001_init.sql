-- Initial schema. See docs/02-architecture.md and the ER diagram in
-- hive-master-plan.md §3.
--
-- Note what is deliberately absent: any column holding message bodies or
-- attachments. message_index is metadata only, and the privacy policy depends
-- on that remaining true.

CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Only ever a hash. The raw session token exists in the cookie and nowhere
    -- else, so a database leak does not hand over live sessions.
    token_hash  TEXT NOT NULL UNIQUE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS connected_accounts (
    id                      TEXT PRIMARY KEY,
    owner_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gmail_address           TEXT NOT NULL,
    -- AES-GCM ciphertext, keyed by TOKEN_ENCRYPTION_KEY. Never logged.
    encrypted_oauth_tokens  TEXT NOT NULL,
    status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'reauth_required')),
    -- Gmail's incremental-sync cursor. Only reaches back ~30 days; if a sync
    -- gap exceeds that, this is stale and a full re-index is required.
    history_id              TEXT,
    last_synced_at          TEXT,
    connected_at            TEXT NOT NULL DEFAULT (datetime('now')),

    -- The same inbox must not be connected twice by one user.
    UNIQUE (owner_id, gmail_address)
);

CREATE INDEX IF NOT EXISTS idx_accounts_owner ON connected_accounts(owner_id);

CREATE TABLE IF NOT EXISTS message_index (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
    gmail_message_id  TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    from_addr         TEXT NOT NULL,
    subject           TEXT NOT NULL DEFAULT '',
    -- Gmail's own short preview string. NOT the message body.
    snippet           TEXT NOT NULL DEFAULT '',
    labels_json       TEXT NOT NULL DEFAULT '[]',
    received_at       TEXT NOT NULL,
    indexed_at        TEXT NOT NULL DEFAULT (datetime('now')),

    UNIQUE (account_id, gmail_message_id)
);

-- The unified inbox is "newest first, across these accounts", so the account
-- and date belong in one composite index rather than two separate ones.
CREATE INDEX IF NOT EXISTS idx_messages_account_date
    ON message_index(account_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_thread
    ON message_index(account_id, thread_id);

CREATE TABLE IF NOT EXISTS cleanup_rules (
    id           TEXT PRIMARY KEY,
    account_id   TEXT NOT NULL REFERENCES connected_accounts(id) ON DELETE CASCADE,
    -- Gmail search syntax, e.g. 'category:promotions older_than:30d'.
    query        TEXT NOT NULL,
    -- Trash only, by design. See ADR 0001.
    action       TEXT NOT NULL DEFAULT 'trash' CHECK (action = 'trash'),
    schedule     TEXT NOT NULL DEFAULT 'manual'
                 CHECK (schedule IN ('manual', 'daily', 'weekly')),
    enabled      INTEGER NOT NULL DEFAULT 1,
    last_run_at  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rules_account ON cleanup_rules(account_id);
-- The cron pass asks "which enabled, scheduled rules are due?" — this serves it.
CREATE INDEX IF NOT EXISTS idx_rules_due ON cleanup_rules(schedule, enabled);

CREATE TABLE IF NOT EXISTS audit_log (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- Nullable, and ON DELETE SET NULL rather than CASCADE: disconnecting an
    -- account must not erase the record of what was done with it.
    account_id    TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
    action        TEXT NOT NULL
                  CHECK (action IN ('connect','disconnect','trash','send','rule_run')),
    details_json  TEXT NOT NULL DEFAULT '{}',
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_user_date ON audit_log(user_id, created_at DESC);

-- Short-lived login codes. Hashed, single-use, rate-limited by the route.
CREATE TABLE IF NOT EXISTS login_otps (
    id          TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    consumed_at TEXT,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_otps_email ON login_otps(email, created_at DESC);
