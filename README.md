# GymNation Evaluation

A Gulf gym membership invoicing and gateway reconciliation API built with Elysia, Bun, and ordinary TypeScript. Scaffolded with `bun create elysia .`.

```sh
bun install --frozen-lockfile
bun start
```

The server listens on `0.0.0.0:8080`.

```sh
docker build -t app .
docker run --rm -p 8080:8080 app
docker build --target test .
```

## Routes

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Readiness |
| POST | `/members` | Create a member and normalize their mobile |
| GET | `/members/lookup?phone=...&country=SA` | Look up a phone; country is needed for national numbers |
| POST | `/plans` | Create a country-specific plan |
| POST | `/agreements` | Link a member to a plan |
| GET | `/agreements/:id/invoices?from=YYYY-MM-DD&to=YYYY-MM-DD` | Compute an inclusive invoice schedule |
| POST | `/reconciliation/runs` | Reconcile a month's gateway rows |
| GET | `/reconciliation/runs/:id` | Retrieve an unchanged run snapshot |

Send request bodies as `application/json`. Money is an integer in minor units. Errors have the form `{"error":{"code":"...","message":"..."}}`.

## Example

```sh
curl http://localhost:8080/health

curl -X POST http://localhost:8080/members \
  -H 'Content-Type: application/json' \
  -d '{"name":"Noura Al Harbi","country":"SA","phone":"055 123 4567"}'

curl -X POST http://localhost:8080/plans \
  -H 'Content-Type: application/json' \
  -d '{"id":"anytime-sa","country":"SA","monthly":29900,"joining_fee":0}'

# Replace MEMBER_ID with the id returned by POST /members.
curl -X POST http://localhost:8080/agreements \
  -H 'Content-Type: application/json' \
  -d '{"member_id":"MEMBER_ID","plan_id":"anytime-sa","start_date":"2026-09-20","due_day":1}'

# Replace AGREEMENT_ID with the id returned by POST /agreements.
curl 'http://localhost:8080/agreements/AGREEMENT_ID/invoices?from=2026-09-01&to=2026-12-31'

curl -X POST http://localhost:8080/reconciliation/runs \
  -H 'Content-Type: application/json' \
  -d '{"month":"2026-10","rows":[{"gateway_txn_id":"T-88121","agreement_id":"AGREEMENT_ID","amount":34385,"currency":"SAR","status":"SETTLED","attempted_on":"2026-10-01"}]}'
```

The example commands use POSIX shell quoting; on Windows, use `curl.exe` with appropriate quoting or PowerShell's `Invoke-RestMethod`.

See [NOTES.md](NOTES.md) for tests, design, assumptions, and scope, and [PROMPTS.md](PROMPTS.md) for the AI conversation record.
