# ADR 0001 — Trash, not permanent delete

**Status:** Accepted
**Date:** 2026-08-22

## Context

Hive's core value is bulk-cleaning cluttered inboxes. The obvious
implementation of "delete 5,000 promotional emails" is Gmail's
`users.messages.batchDelete`, which permanently removes messages.

That API requires the `https://mail.google.com/` scope — full mailbox access,
which Google classifies as **restricted**, its highest sensitivity tier.
Requesting a restricted scope in a public app triggers a CASA security
assessment on top of the normal OAuth verification review. Sensitive-tier
scopes (`gmail.readonly`, `gmail.modify`, `gmail.send`) do not.

The alternative is `users.messages.batchModify`, moving messages to Trash,
which needs only `gmail.modify`.

## Decision

The hosted product requests exactly three scopes — `gmail.readonly`,
`gmail.modify`, `gmail.send` — and implements "delete" as **trash** via
`batchModify`. `batchDelete` and `https://mail.google.com/` are not used.

Self-hosted instances may add the restricted scope themselves; this is
documented in `docs/SELF-HOSTING.md` as an explicit opt-in.

## Rationale

Gmail empties its own Trash after 30 days. From the user's point of view the
mail does get deleted — just on a delay. So the restricted scope buys
immediacy, and immediacy alone, at the cost of:

- an additional security assessment before public launch,
- a scarier consent screen asking for total mailbox access,
- irreversibility, with no undo for a mistaken bulk action.

That trade is clearly bad for a bulk-deletion tool, where a wrong search query
is a plausible user error. The 30-day Trash window is a safety net, not just a
compliance workaround.

Being open source means this is not a limitation imposed on anyone who
genuinely disagrees — they can run their own instance with their own scopes.

## Consequences

- Verification follows the standard free path; no CASA.
- Users who want mail gone immediately must empty Gmail's Trash themselves.
  The UI should say "Move to Trash", never "Delete", so this is not a
  surprise.
- Bulk actions are reversible for 30 days, which materially lowers the risk of
  the product's most dangerous operation.
- Adding `https://mail.google.com/` later is not a code change but a
  verification-status change, and requires superseding this ADR.
