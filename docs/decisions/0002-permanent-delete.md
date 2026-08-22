# ADR 0002 — Permanent delete, and the restricted scope it needs

**Status:** Accepted
**Date:** 2026-08-22
**Supersedes:** [ADR 0001](0001-trash-not-permanent-delete.md)

## Context

ADR 0001 restricted the hosted product to moving mail to Trash, on the
reasoning that Gmail empties Trash after 30 days so the user-visible outcome is
the same without the restricted scope.

In practice that reasoning does not cover the actual need. A user cleaning out
tens of thousands of messages wants the storage back **now**, and wants control
over the bin itself — not a 30-day wait during which the quota is still
consumed. "It will be gone next month" is not the same product as "it is gone".

## Decision

The hosted product requests `https://mail.google.com/` in addition to
`gmail.readonly`, `gmail.modify` and `gmail.send`, and offers:

- a **Trash view** — everything currently in the bin,
- **restore**, moving a message back out of Trash,
- **permanent delete** of selected messages, via `users.messages.batchDelete`,
- **empty Trash**, permanently deleting everything in the bin.

## What this costs, accepted knowingly

This is the expensive lane, and the reasons ADR 0001 avoided it have not
stopped being true:

1. **CASA security assessment.** `https://mail.google.com/` is a restricted
   scope. Verification now requires a Tier 2 CASA assessment on top of the
   normal review. Current Google guidance allows many apps to complete Tier 2
   by self-assessment questionnaire rather than a paid third-party auditor, but
   it is an extra process with its own timeline.
2. **A scarier consent screen.** Users are asked to grant full mailbox access —
   "Read, compose, send and permanently delete all your email from Gmail". Some
   will decline at that screen who would have accepted a narrower request.
3. **Longer elapsed time to public launch.** Verification with a restricted
   scope takes materially longer. Testing mode (100 users) still works
   throughout, so development is not blocked.
4. **No undo.** `batchDelete` does not move messages anywhere. There is no
   Trash, no recovery, no support ticket that gets it back.

## Consequences for the implementation

Because point 4 has no technical mitigation, the safety has to be in the
product:

- Permanent delete is **never** the default action. Bulk cleanup and cleanup
  rules still trash; permanent delete is a separate, explicit action taken from
  the Trash view.
- Every permanent delete is **type-to-confirm**, showing the exact count. A
  single misclick must not be able to destroy mail.
- Cleanup rules may **never** permanently delete, on any schedule. An automated
  irreversible action against a query the user wrote weeks ago is the single
  most dangerous thing this codebase could do.
- Every permanent delete writes an `audit_log` row with the count before the
  call is made — if it goes wrong, there is at least a record of what was
  destroyed.

## Cost posture

The project has a hard constraint of costing nothing to run. This decision does
not breach it *yet*, and the distinction matters:

- **In Testing mode — where the app is now — the restricted scope is free.**
  No verification, no CASA, up to 100 test users. Permanent delete works today
  at zero cost.
- **CASA only applies at public launch**, when strangers can sign up. Google's
  Tier 2 self-assessment questionnaire is free for many apps, but some are
  required to use a paid third-party assessor, which is expensive.

So the risk is not a bill now; it is a possible bill later, at the point of
going public. That decision is deferred, and it stays cheap to reverse because
of the runtime scope check described above: dropping
`https://mail.google.com/` from the consent screen degrades the Trash view to
view-and-restore without a code change.

**Do not treat public launch as a formality.** Before submitting for
verification, confirm which CASA tier applies and what it costs. If it is not
free, dropping the scope is the expected answer.

## Revisiting

If CASA proves more onerous than expected, the fallback is not a code rewrite:
drop the scope from the consent screen and the Trash view degrades to
view-and-restore, which works on `gmail.modify` alone. The permanent-delete
controls check the granted scope at runtime rather than assuming it.
