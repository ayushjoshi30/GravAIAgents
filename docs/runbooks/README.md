# Runbooks

Written to be followed at 3am by someone who did not build this.

Each one states what you will see, what to check first, and what to do — in that
order. Where a step is destructive it says so before the command, not after.

| Runbook | When |
|---|---|
| [provider-outage.md](provider-outage.md) | Agent runs failing; circuit breaker open |
| [rate-limit-saturation.md](rate-limit-saturation.md) | Queue depth climbing; documents not clearing |
| [backup-restore.md](backup-restore.md) | Data loss, corruption, or the quarterly drill |
| [incident-response.md](incident-response.md) | Suspected breach, data exposure, or a conduct failure |
| [key-rotation.md](key-rotation.md) | Scheduled rotation, or a credential is suspected leaked |
| [data-subject-request.md](data-subject-request.md) | A borrower asks for access, correction or erasure |
| [prompt-rollback.md](prompt-rollback.md) | An agent's output quality regressed after a promotion |
| [tenant-onboarding.md](tenant-onboarding.md) | Bringing a new lender live |

## Before you start, anywhere

```bash
curl -s localhost:8000/readyz | jq          # what the platform thinks is true
uv run python -c "from gravai_sarvam import build_sarvam; b=build_sarvam(); print(b.governor.stats('docai'))"
```

`/readyz` tells you the database dialect, whether row-level security is active,
whether the AI layer is in sandbox, and which auth path is live. More incidents
than you would expect are explained by one of those four being unexpected.

## The three facts worth knowing cold

1. **The document rate limit is 10 requests a minute, per account, uniform
   across plan tiers.** It is not a per-worker limit, so scaling workers does
   nothing. Confirmed verbatim in the provider's documentation.
2. **Polling is roughly three quarters of all request volume.** When traffic
   looks inexplicably high, it is almost always status polls, not submissions.
3. **Credit decisions never complete without a human.** If work appears stuck,
   check the review queue before assuming a fault: `GET /v1/tasks?status=open`.
