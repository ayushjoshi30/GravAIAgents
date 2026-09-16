# Provider outage

## What you will see

- Agent runs failing with `sarvam_server_error` or `sarvam_auth_error`.
- Logs carrying `sarvam_retry` repeatedly, then a refusal naming the circuit breaker.
- Review queue growing; document jobs not completing.
- `/readyz` still healthy — it does not probe the AI provider, deliberately, so
  that a vendor problem does not get the containers killed.

## Triage, in order

**1. Is it us or them?**

```bash
uv run python -c "
import asyncio
from gravai_sarvam.probe import Prober
print(asyncio.run(Prober().connectivity()).render())
"
```

| Result | Meaning |
|---|---|
| `PASS` | The provider is up. The problem is ours — go to step 3. |
| `401`/`403` | Credential problem, not an outage → [key-rotation.md](key-rotation.md) |
| `Unexpected status` | An endpoint path may have changed → step 4 |
| Transport error | Network or genuine outage → step 2 |

**2. Confirm the blast radius.** Breakers are per product, so document
intelligence can be down while chat is fine.

```bash
grep -c "sarvam_retry" logs/*.log
grep "circuit breaker is open" logs/*.log | tail -20
```

**3. Decide: wait or shed.**

The breaker already stops the platform hammering a failing provider — it opens
after 5 consecutive failures and half-opens after 30 seconds, so recovery is
automatic. You do not need to do anything for a short outage.

Act only if it is sustained:

- **Under 15 minutes:** do nothing. Temporal retries the activities; runs
  resume. Tell support "delayed, not lost".
- **Over 15 minutes:** pause new document intake so the backlog does not
  outgrow the drain window. Existing runs stay queued.
- **Over 2 hours:** notify affected tenants. Work out the drain time before you
  promise a recovery window:

```bash
curl -s "localhost:8000/v1/usage/backlog?documents=<queued>" \
  -H "Authorization: Bearer $TOKEN" | jq '.active, .spread_factor'
```

**4. If an endpoint changed rather than failed.** Every path is configuration,
not code:

```bash
# .env — no deploy required
SARVAM_DOCAI_EXTRACT_PATH=/doc-ai/v2/job/extract
```

Restart the workers. Record it in `DECISIONS.md` against D-004.

## Recovery

The breaker half-opens by itself. To confirm recovery rather than wait:

```bash
uv run python -c "
import asyncio
from gravai_sarvam.probe import Prober
async def main():
    p = Prober()
    for probe in (await p.connectivity(), await p.chat()):
        print(probe.render())
asyncio.run(main())
"
```

Then watch queue depth fall:

```bash
watch -n 10 'curl -s localhost:8000/v1/usage/throughput -H "Authorization: Bearer $TOKEN" | jq .queue_depth'
```

## Do not

- **Do not raise `SARVAM_DOCAI_RPM` to clear a backlog faster.** The ceiling is
  the provider's, not ours. Raising it only moves the 429s from our queue into
  their API, and the platform then retries them — strictly worse.
- **Do not disable the circuit breaker** to "get some throughput". It exists to
  stop spending money on requests that are failing.
- **Do not switch to sandbox to make errors go away.** Sandbox output must never
  underwrite a real decision; every sandbox run escalates for exactly this reason.

## Afterwards

Record the outage window, the number of affected runs, and whether any tenant
breached an SLA. If the provider's behaviour differed from its documentation,
add or amend a `DECISIONS.md` entry — that file is how the next person avoids
re-learning this.
