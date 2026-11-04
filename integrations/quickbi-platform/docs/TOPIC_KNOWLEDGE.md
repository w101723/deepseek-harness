# AIPro analysis topics and business knowledge (Batch 07)

Topics are bound to one data set, owned by one tenant user and initially drafted. Owners with editor/admin role may update the topic metadata and attach at most 20 business notes: `glossary`, `rule` or `example` (max 2000 characters each).

On **any edit** (including knowledge deletion), a published topic is automatically returned to `draft` and its version is incremented. `POST /api/ai/topics/:id/publish` publishes the edited version. Existing analysis sessions remain pinned to the exact topic version chosen when created. Attempting to analyze under a modified topic returns HTTP 409 and requires a new session; the system never silently modifies an established conversation's grounding.

Notes are included in AI planning and native Harness prompt as **untrusted business context**, not system instructions, SQL, credentials or executable tools. Real authorization remains in the QuerySpec compiler and dataset policies. Model-generated summaries are not authoritative evidence.

New routes (all require authentication; writes require CSRF):

- `GET /api/ai/topics/:id` returns authorized metadata + knowledge.
- `PATCH /api/ai/topics/:id` with `version`, `name`, `description` updates owner draft.
- `GET /api/ai/topics/:id/knowledge` lists business notes.
- `POST /api/ai/topics/:id/knowledge` with `version`, `kind`, `title`, `content` adds owner note.
- `DELETE /api/ai/topics/:id/knowledge/:entryId` with JSON body `{ "version": n }` deletes owner note.

Tenant and dataset access are verified for reads, and only the creator may edit. All changes are audited. Publishing and knowledge changes invalidate the previously pinned topic versions for **future** analysis requests, not the already recorded historical data snapshots; dataset-policy changes additionally redact existing historical query evidence.

Test evidence: `test/topic-knowledge.test.mjs` covers create, versioning, owner restrictions, dataset policy restrictions, cross-tenant access, stale session rejection, and business knowledge forwarding to agent planner.
