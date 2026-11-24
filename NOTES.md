# Gym membership invoice API

## Run

Requires Bun 1.3.14 (the version pinned in Docker).

```sh
bun install --frozen-lockfile
bun start
```

The API listens on `0.0.0.0:8080`. `GET /health` returns `200 {"status":"ok"}`. No environment variables, credentials, database setup, or runtime network access are needed. Each process starts empty; no plans or members are seeded.

```sh
docker build -t app .
docker run --rm -p 8080:8080 app
```

## Verify

```sh
bun run check
docker build --target test .
```

`check` runs TypeScript checking and Bun tests. Tests exercise all routes, malformed JSON, strict numeric types, phone aliases, concurrent duplicate creation, the worked invoice examples, month-end and leap-year schedules, exact half-up rounding, range boundaries, all reconciliation verdicts, row-order independence, and stored snapshots. One concurrency test uses a real local HTTP listener.

With a server already running, `bun run tests/smoke.ts` exercises the production HTTP workflows. This smoke test creates records, so use a disposable server for verification.

The Docker `test` stage runs these checks during the build. The final runtime stage installs only production dependencies and runs as the unprivileged `bun` user. The build context excludes local dependencies and Git history.

Verified on 2026-11-11: TypeScript checking and all 106 tests passed; `docker build --target test .` and `docker build -t app .` succeeded. The production HTTP smoke test passed through published port 8080 and again inside a container with `--network none`. Temporary verification containers were stopped afterward.

## Design

- `src/app.ts`: route schemas, HTTP errors, and member/plan/agreement operations.
- `src/phones.ts`: canonical E.164 normalization and country-specific rules.
- `src/dates.ts`: validated calendar dates, UTC epoch-day arithmetic, and month anchors.
- `src/invoices.ts`: pure schedule generation and exact `bigint` arithmetic before JSON-number conversion.
- `src/changes.ts`: change validation in the required order, idempotency, and conflict prevention.
- `src/billing.ts`: chronological freezes, effective plan history, immutable closed invoices, and correction carry-forward.
- `src/reconciliation.ts`: whole-request row validation, independent candidate selection, link counting, and unmatched sorting.
- `src/models.ts`: domain types, country settings, and per-process in-memory maps.
- `src/index.ts`: production listener and graceful shutdown.

Phone and plan uniqueness checks and writes happen synchronously without an intervening `await`. A single Bun process therefore cannot interleave two writes inside these critical sections. Reconciliation also takes a synchronous snapshot. Do not add multiple workers or replicas sharing these in-memory stores; that would require a transactional shared database with uniqueness constraints.

Unchanged agreements retain the original direct month lookup. Changed agreements replay their schedule from the start so fees, invoice numbers, and credits do not depend on the requested date window. Monetary calculations never use major units or floating-point rounding. Reconciliation chooses candidates before counting their links so request order does not determine the winner. Stored runs remain unchanged when new agreements or changes are created.

## Live extension (2026-11-24)

`POST /agreements/:id/changes` accepts the FREEZE and PLAN bodies from the interview specification. Change IDs are scoped to an agreement, and exact retries (independent of JSON property order) return 200. Unknown agreement checks run before body parsing, as required. Calendar validation precedes idempotency; the remaining business checks follow the specified error order.

Freezes are sorted by `from` and applied to the schedule left by earlier freezes. The moved invoice keeps its number and accumulates any freeze fee. Its landing day becomes the monthly anchor for later invoices. The first freeze per agreement per calendar year is free; further freezes cost 2500 AED/SAR minor units or 2000 BHD minor units, before VAT. Invoice 1's original proration remains unchanged.

Plan changes are sorted by `on`. Each compares its new price with the effective plan on the preceding day; pending downgrades are excluded. Same-price changes and upgrades take effect immediately, while downgrades wait for a due date at least seven days later. Each upgrade's catch-up charge independently rounds its old and new prorations, excluding frozen days. Joining fees never recur.

`POST /months/close` snapshots every invoice through the given month and advances one global closure watermark. Existing snapshots are preserved. Future calculations subtract actual closed net charges (including past corrections) from the closed net charges that the current change history would require before corrections. That balance goes onto the earliest open invoice, with negative overflow carried forward. Merely reading invoices does not consume credit. VAT is recalculated on adjusted nonnegative net amounts. Reconciliation omits zero-total invoices.

All change validations/writes and month-close snapshots/commits are synchronous in the single Bun process. The closure operation stages all snapshots before committing them. Tests include real HTTP races for overlapping freezes and closing a month while recording a freeze.

The six printed examples and additional extension edge cases are in `tests/live.test.ts`. Run `bun run check` for both the original and extension suites. To replay the six examples against an **empty disposable server**, run `bun run tests/live-smoke.ts http://localhost:8080`; this writes records and closes March globally. The interviewer's `sample-checks.mjs` was not present in the repository or Downloads when checked; the printed examples are covered by our own tests.

Verified on 2026-11-24: all 151 tests (106 original plus 45 extension tests) and TypeScript checks passed. Both Docker stages built successfully. All six examples passed against the production container through port 8080 and again with `--network none`. Verification containers were stopped. Changes remain uncommitted on `live` for review, as requested.

## Assumptions

- Accepted calendar years are `0001` through `9999`, with proleptic Gregorian leap-year rules.
- A range ending exactly 366 days after its start is valid, with both endpoints included.
- JSON money values and every resulting invoice amount must fit JavaScript's safe integer range; a plan whose full monthly charge plus joining fee and VAT would overflow is rejected with `422 VALIDATION`.
- Plan IDs, transaction IDs, and reference IDs must be nonempty strings; their characters and lengths are otherwise unrestricted.
- Unexpected object fields are rejected as malformed input rather than silently discarded.
- Phone cleanup removes ASCII spaces, hyphens, and round brackets; tabs, letters, non-ASCII digits, and other punctuation are invalid.
- Original routes retain schema/calendar error precedence; the change endpoint explicitly checks unknown agreement first, including before malformed JSON.
- When both agreement references are unknown, `UNKNOWN_MEMBER` takes precedence over `UNKNOWN_PLAN`.
- Gateway transaction IDs are unique within a run only; the same file may be reconciled in a new independent run.
- Reconciliation's three row-rule errors are accumulated after structural and calendar validation succeeds; each duplicate row contributes its own `DUPLICATE_TXN` entry.
- Unmatched invoice ordering uses ordinal string comparison for agreement IDs.

## Skipped

No required parts were intentionally skipped. Authentication, durable storage, multi-process deployment, cancellation/end dates, and a UI are outside the assignment. State is intentionally lost on restart.

## References

- [Elysia route validation](https://elysiajs.com/essential/validation)
- [Bun Docker guide](https://bun.sh/guides/ecosystem/docker)

The installed Elysia source was also inspected: its `t.Integer` accepts numeric strings, so numeric request fields use `t.Number({ multipleOf: 1, ... })` to enforce the assignment's strict JSON types.
