# Rate limit saturation and backlog drain

The most common operational problem, and the one most often misdiagnosed as a
performance bug. It is not a bug: it is the vendor ceiling doing its job.

## What you will see

- Queue depth climbing in the throughput panel.
- Documents taking minutes rather than seconds, with no errors at all.
- Worker CPU near idle — everything is waiting on the governor, not computing.

## Understand the arithmetic before touching anything

```bash
curl -s localhost:8000/v1/usage/throughput -H "Authorization: Bearer $TOKEN" | jq
```

| Field | Read it as |
|---|---|
| `configured_limit_per_minute` | The vendor ceiling — 10 |
| `quota_units_per_document` | Usually 12: one submit, ten polls, one results fetch |
| `documents_per_hour` | What the account can physically do |
| `queue_depth` | Units waiting, not documents |
| `served_by_tenant` | Who is consuming the quota |

**A document is not a request.** One document is about twelve calls, and a
document over ten pages is two jobs — so a twelve-page bank statement is
twenty-four. Counting documents will mislead you every time.

## Decide what is actually wrong

**Is demand simply above capacity?**

```bash
curl -s "localhost:8000/v1/usage/backlog?documents=<count>" -H "Authorization: Bearer $TOKEN" | jq
```

If `active.days_continuous` exceeds your window, no amount of tuning helps. This
is a commercial conversation with the vendor, not an engineering one. Take the
figure with you.

**Is one tenant consuming everything?** Check `served_by_tenant`. The governor
shares fairly under sustained pressure — measured at 20% each across five
tenants even when one offers 62% of the load — so a lopsided split means either
the others are idle (fine) or a per-tenant budget is misconfigured.

**Is it self-inflicted?** The two settings that move quota consumption by more
than an order of magnitude:

```bash
grep -E "POLLS_COUNT|MAX_PAGES" .env
```

- `SARVAM_DOCAI_POLLS_COUNT_TOWARD_LIMIT=true` is the conservative default. If
  the vendor confirms polls are free, setting this to `false` raises throughput
  roughly twelvefold. **This is the single highest-value question to ask them**
  (DECISIONS.md D-005). Measure it rather than assume:

```bash
uv run python -c "
import asyncio
from gravai_sarvam.probe import Prober
print(asyncio.run(Prober().poll_quota_experiment('<a document url>')).render())
"
```

## What actually helps

| Action | Effect |
|---|---|
| Confirm polls are free with the vendor | Up to 12x throughput |
| Negotiate a committed rate | The only way to raise a per-account ceiling |
| Route fewer documents to digitise | Saves one model call per document, not quota |
| Split fewer documents over 10 pages | Each batch is a whole extra job |
| Prioritise interactive over batch | Does not add capacity; improves what waits |

## What does not help, and why

- **Adding workers.** The ceiling is per account. Ten workers share ten requests
  a minute; they do not get ten each.
- **Raising `SARVAM_DOCAI_RPM` past the real limit.** Moves 429s from our queue
  into their API, where we then retry them. Strictly worse.
- **Routing everything to digitise because it is half the per-page price.**
  It costs the same quota, plus one model call per document. It is a unit-cost
  decision, never a throughput one.

## If you must shed load

In priority order: pause backlog reprocessing, then batch intake, then
non-interactive agents. Never pause the review queue — those are human decisions
already waiting on someone.
