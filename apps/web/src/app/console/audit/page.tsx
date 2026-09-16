"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Chip, Eyebrow, Figure, Skeleton, type Tone } from "@/components/console/primitives";
import { Icon } from "@/components/icons/AgentIcon";
import { Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Field";
import { ApiFailureBanner, InlineNote, UnknownRatherThanEmpty } from "@/components/ui/States";
import { type AuditEntryOut, type ChainVerificationOut, api } from "@/lib/api";
import { formatCount, formatDateTimeIst, shortHash } from "@/lib/format";
import { useToken } from "@/lib/session";
import { useResource } from "@/lib/useResource";

/**
 * Audit chain.
 *
 * The strip along the top is the point of this redesign. The log was always
 * hash-chained, but a table of rows shows a reader a list — it never shows them
 * that each row's hash is computed from the one before it, which is the whole
 * security property. Drawing the links makes the claim legible, and makes a
 * break impossible to miss: the segment where verification stopped turns red
 * and every node after it does too.
 *
 * Verify is a real control, not a decoration: `POST /v1/audit/verify` exists in
 * this API build and returns the first sequence number that does not follow.
 */

/** How many links the strip draws. Enough to read; few enough to stay legible. */
const STRIP_LENGTH = 24;

/**
 * One page of the log. Named because the listing has to say when it fills up:
 * an auditor reading a truncated chain needs to know it was truncated, which is
 * the only part of the old "entries" figure anybody could have acted on.
 */
const AUDIT_PAGE_LIMIT = 1000;

/**
 * No chain until the API hands one over.
 *
 * A written-out chain of plausible entries and plausible hashes used to stand
 * in here. Of everything this console fabricated, that was the most dangerous:
 * an audit trail is the artefact an auditor is handed, and a strip of green
 * links asserts an integrity property. Drawing one this console never computed
 * is the single claim it must never make.
 */
const NO_ENTRIES: AuditEntryOut[] = [];

type VerifyState =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: ChainVerificationOut }
  | { state: "error"; message: string };

export default function AuditExplorerPage() {
  const [token] = useToken();
  const [actorType, setActorType] = useState("");
  const [action, setAction] = useState("");
  const [entityId, setEntityId] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<AuditEntryOut | null>(null);
  const [verify, setVerify] = useState<VerifyState>({ state: "idle" });

  const audit = useResource(
    `audit:${token ?? "none"}`,
    (signal) => api.listAudit(token, { limit: AUDIT_PAGE_LIMIT }, signal),
    NO_ENTRIES,
  );

  const actions = useMemo(
    () => Array.from(new Set(audit.data.map((entry) => entry.action))).sort(),
    [audit.data],
  );
  const actorTypes = useMemo(
    () => Array.from(new Set(audit.data.map((entry) => entry.actor_type))).sort(),
    [audit.data],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return audit.data.filter((entry) => {
      if (actorType && entry.actor_type !== actorType) return false;
      if (action && entry.action !== action) return false;
      if (entityId && !entry.entity_id.toLowerCase().includes(entityId.toLowerCase()))
        return false;
      if (!needle) return true;
      return (
        // Sequence is matched whole, and with an optional leading "#" so the
        // number can be pasted the way the rows and the strip print it. Whole
        // rather than as a substring because "broken at sequence 412" must land
        // on 412 and not also on 4120. Verification names a sequence and this is
        // the only way to reach the row it names: the strip draws the newest
        // links, and a break is usually older than those.
        String(entry.seq) === needle ||
        (needle.startsWith("#") && String(entry.seq) === needle.slice(1)) ||
        entry.actor_id.toLowerCase().includes(needle) ||
        entry.action.toLowerCase().includes(needle) ||
        entry.entity_id.toLowerCase().includes(needle) ||
        entry.hash.startsWith(needle)
      );
    });
  }, [audit.data, actorType, action, entityId, query]);

  /**
   * The strip always draws the newest links in the whole chain, never the
   * filtered set. A filtered chain is not a chain: hiding the rows between two
   * entries would draw a link between hashes that do not in fact follow.
   */
  const strip = useMemo(
    () => [...audit.data].sort((a, b) => a.seq - b.seq).slice(-STRIP_LENGTH),
    [audit.data],
  );

  /**
   * Verification is the API's answer or it is nothing.
   *
   * This used to fall back to a canned "chain intact" verdict whenever the API
   * could not be asked, labelled as an example. A verdict is not an
   * illustration: it is the assertion that every hash was recomputed and
   * followed. Unreachable, unauthorised or not-yet-shipped all now report that
   * the check did not run, which is the truth in every one of those cases.
   */
  const runVerification = () => {
    setVerify({ state: "running" });
    void api.verifyAudit(token).then((result) => {
      if (result.ok) {
        setVerify({ state: "done", result: result.data });
      } else {
        setVerify({
          state: "error",
          message: `${result.message}${result.status ? ` (HTTP ${result.status})` : ""}${
            result.correlationId ? ` · correlation ${result.correlationId}` : ""
          }`,
        });
      }
    });
  };

  const verdict = verify.state === "done" ? verify.result : null;
  const loading = audit.mode === "loading";
  const failure = audit.failure;
  const answered = !loading && !failure;
  const filtersApplied = Boolean(actorType || action || entityId || query.trim());

  return (
    <div className="gv-rise space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Eyebrow>Platform · Audit chain</Eyebrow>
          <h1 className="gv-page-title mt-1.5">Audit chain</h1>
          <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
            An append-only log, hash-chained per tenant. A database trigger forbids UPDATE and
            DELETE, and verification recomputes every hash from the genesis entry rather than
            trusting the one stored beside it.
          </p>
        </div>
        <Button
          variant="primary"
          onClick={runVerification}
          disabled={verify.state === "running"}
          className="shrink-0"
        >
          <Icon name="chain" size={14} />
          {verify.state === "running" ? "Recomputing…" : "Verify chain"}
        </Button>
      </header>

      <ApiFailureBanner failure={failure} onRetry={audit.reload} what="audit entries" />

      {/* --- The chain itself --------------------------------------------- */}
      <section aria-labelledby="chain-strip" className="gv-card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          {/* "The last 0 links" is a count of something, and there is nothing
              to count until the chain has been read. The heading names the
              section in that case instead of reporting a zero. */}
          <h2 id="chain-strip" className="text-[15px] font-semibold text-ink">
            {strip.length === 0 ? "The chain" : `The last ${strip.length} links`}
          </h2>
          <p className="text-[12px] text-ink-3">
            Each entry hashes the one before it. Select a link to read the entry it stands for.
          </p>
        </div>

        {loading ? (
          <div className="mt-3.5 flex items-center gap-2 overflow-hidden">
            {Array.from({ length: 10 }, (_, index) => (
              <Skeleton key={index} h={54} w={96} />
            ))}
          </div>
        ) : failure ? (
          <p className="mt-3.5 text-[13px] leading-relaxed text-ink-3">
            No chain is drawn, because none was read. This console will not draw links it did not
            receive — a chain on screen is evidence, and evidence cannot be improvised while the
            API is unavailable.
          </p>
        ) : strip.length === 0 ? (
          <p className="mt-3.5 text-[13px] leading-relaxed text-ink-3">
            Nothing has been recorded for this tenant yet, so there is no chain to draw. The
            first entry is written the moment an agent runs or a person decides something.
          </p>
        ) : (
          <ol className="mt-3.5 flex items-stretch overflow-x-auto pb-1">
            {strip.map((entry, index) => {
              const state = linkState(entry, verdict);
              const on = selected?.id === entry.id;
              return (
                <li key={entry.id} className="flex shrink-0 items-center">
                  {index > 0 ? (
                    <span
                      aria-hidden="true"
                      className={`h-px w-4 ${state === "bad" ? "bg-bad" : "bg-navy-line"}`}
                    />
                  ) : null}
                  <button
                    type="button"
                    onClick={() => setSelected(entry)}
                    aria-label={`Audit entry ${entry.seq}, ${entry.action}, hash ${shortHash(entry.hash, 8)}`}
                    aria-current={on ? "true" : undefined}
                    className={`gv-node w-[104px] px-2.5 py-2 ${on ? "gv-node-selected" : ""} ${
                      state === "bad"
                        ? "border-bad"
                        : state === "ok"
                          ? "border-ok"
                          : "border-navy-line"
                    }`}
                  >
                    <span className="block font-mono text-[11px] text-ink-3">#{entry.seq}</span>
                    <span className="mt-0.5 block truncate text-[11.5px] font-medium text-ink">
                      {entry.action}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[10.5px] text-ink-4">
                      {shortHash(entry.hash, 6)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        <VerifyReport verify={verify} />
      </section>

      {/* Four figures stood between the chain and the entries: how many entries
          were read, how many matched the filters, how many distinct actions
          appeared among them, and the retention period. Nobody acts on any of
          the four. The first two were counts of the list immediately below them,
          the third was analysis the Action filter already does better by naming
          the actions rather than counting them, and retention is policy rather
          than a reading — it is stated as policy in the note at the foot of this
          page instead. Nothing that helps anyone prove the chain is intact was
          touched: verification, its entry count and the first bad sequence stay
          where the chain is drawn.

          What the entries figure alone could tell a reader — that the page was
          full, so the chain continues past the oldest row shown — is kept below
          the listing, where it is a caveat on the rows rather than a statistic
          about them. */}

      <div className="gv-card grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
        <TextField
          label="Search"
          value={query}
          onChange={setQuery}
          placeholder="Sequence, actor, action, entity or hash prefix"
          type="search"
        />
        <SelectField
          label="Actor type"
          value={actorType}
          onChange={setActorType}
          options={[
            { value: "", label: "All actors" },
            ...actorTypes.map((value) => ({ value, label: value })),
          ]}
        />
        <SelectField
          label="Action"
          value={action}
          onChange={setAction}
          options={[
            { value: "", label: "All actions" },
            ...actions.map((value) => ({ value, label: value })),
          ]}
        />
        <TextField
          label="Entity id"
          value={entityId}
          onChange={setEntityId}
          placeholder="e.g. GRV-18301"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
        <section aria-label="Audit entries" className="gv-card overflow-hidden">
          {loading ? (
            <RowSkeletons />
          ) : failure ? (
            <UnknownRatherThanEmpty>
              No entries are listed because the request above did not succeed. An audit trail
              that could not be read is not an audit trail that is empty, and this screen will
              not let the two look alike.
            </UnknownRatherThanEmpty>
          ) : filtered.length === 0 ? (
            <UnknownRatherThanEmpty>
              {filtersApplied
                ? "No entry matches these filters. The chain is unaffected — only this listing is."
                : "Nothing has been recorded for this tenant yet. Entries appear here as agents run and people decide."}
            </UnknownRatherThanEmpty>
          ) : (
            <ul className="max-h-[560px] overflow-y-auto">
              {filtered.map((entry) => (
                <AuditRow
                  key={entry.id}
                  entry={entry}
                  selected={selected?.id === entry.id}
                  onSelect={() => setSelected(entry)}
                />
              ))}
            </ul>
          )}

          {/* Shown only when it is true. A listing that stops at the page limit
              is the one case where the number of rows read means something to an
              auditor, because the chain carries on past the oldest one here. */}
          {answered && audit.data.length >= AUDIT_PAGE_LIMIT ? (
            <p className="border-t border-line-2 px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-3">
              This is one full page of {formatCount(AUDIT_PAGE_LIMIT)} entries, newest first, so
              the chain continues past the oldest row listed. Verification is unaffected: it
              recomputes every entry for this tenant from the genesis hash, not only the ones
              read here.
            </p>
          ) : null}
        </section>

        <aside aria-label="Entry detail" className="gv-card min-w-0 overflow-hidden">
          <div className="border-b border-line-2 px-4 py-3">
            <h2 className="text-[15px] font-semibold text-ink">Entry detail</h2>
            {!selected ? (
              <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
                Nothing is selected. Pick a link in the strip above or a row on the left to read
                its payload and both of its chain hashes.
              </p>
            ) : null}
          </div>

          {selected ? (
            <div className="p-4">
              <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
                <Detail term="Sequence" mono>
                  {selected.seq}
                </Detail>
                <Detail term="Action" mono>
                  {selected.action}
                </Detail>
                <Detail term="Actor">
                  <span className="flex flex-wrap items-center gap-2">
                    <Chip tone={actorTone(selected.actor_type)}>{selected.actor_type}</Chip>
                    <span className="break-all">{selected.actor_id}</span>
                  </span>
                </Detail>
                <Detail term="Entity" mono>
                  {selected.entity_type} / {selected.entity_id}
                </Detail>
                <Detail term="Recorded" mono>
                  {formatDateTimeIst(selected.recorded_at)}
                </Detail>
                <Detail term="Correlation id" mono>
                  {selected.correlation_id ?? "—"}
                </Detail>
                <Detail term="Previous hash" mono>
                  {shortHash(selected.prev_hash, 16)}
                </Detail>
                <Detail term="Hash" mono>
                  {shortHash(selected.hash, 16)}
                </Detail>
              </dl>

              <p className="gv-eyebrow mt-4 mb-2">Payload</p>
              <pre className="max-h-56 overflow-auto rounded-md border border-line-2 bg-surface-2 p-2.5 font-mono text-[11.5px] leading-relaxed text-ink-2">
                {JSON.stringify(selected.payload, null, 2)}
              </pre>

              {selected.entity_type === "application" ? (
                <Link
                  href={`/console/applications/${selected.entity_id}`}
                  className="gv-link mt-4 inline-block text-[13px]"
                >
                  Open the decision trail for {selected.entity_id}
                </Link>
              ) : null}
            </div>
          ) : null}
        </aside>
      </div>

      <InlineNote>
        The chain is per tenant, not global. A global chain would serialise every write across
        all tenants and leak activity volume between them. Timestamps are canonicalised before
        hashing so the digest does not depend on whether the database dialect stored an aware or
        a naive datetime — a bug that once made every chain fail verification after a reload,
        and the reason the hash format is now frozen and versioned with the chain. Entries are
        retained for eight years, the regulatory minimum this platform is built to; a tenant can
        be configured upwards, never downwards.
      </InlineNote>
    </div>
  );
}

/** What verification found, reported where the chain is drawn rather than at the top of the page. */
function VerifyReport({ verify }: { verify: VerifyState }) {
  if (verify.state === "idle") return null;

  if (verify.state === "running") {
    return (
      <div className="mt-4 grid gap-2 border-t border-line-2 pt-4" role="status" aria-live="polite">
        <Skeleton h={16} w="min(46%, 260px)" />
        <Skeleton h={12} w="min(70%, 420px)" />
      </div>
    );
  }

  if (verify.state === "error") {
    return (
      <div
        className="mt-4 flex flex-wrap items-center gap-2.5 border-t border-line-2 pt-4"
        role="status"
        aria-live="polite"
      >
        <Chip tone="red">Did not run</Chip>
        <p className="text-[13px] text-ink-2">{verify.message}</p>
      </div>
    );
  }

  const { result } = verify;
  return (
    <div className="mt-4 border-t border-line-2 pt-4" role="status" aria-live="polite">
      <p className="flex flex-wrap items-center gap-2">
        <Chip tone={result.ok ? "green" : "red"}>
          {result.ok ? "Chain intact" : `Broken at sequence ${result.first_bad_seq}`}
        </Chip>
      </p>
      <div className="mt-3 grid gap-x-8 gap-y-2 sm:grid-cols-3">
        <Figure
          label="Entries checked"
          value={formatCount(result.checked)}
          size={24}
          note="Recomputed from the genesis hash, not read back from storage."
        />
        <Figure
          label="First bad sequence"
          value={result.first_bad_seq === null ? "none" : String(result.first_bad_seq)}
          size={24}
          tone={result.first_bad_seq === null ? undefined : "red"}
          note={
            result.first_bad_seq === null
              ? "Every hash followed the one before it."
              : "Search this number below to open the row an investigation starts from."
          }
        />
        <div>
          <Eyebrow>Reason</Eyebrow>
          <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{result.reason ?? "—"}</p>
        </div>
      </div>
      <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
        Returned by <span className="font-mono text-[11.5px]">POST /v1/audit/verify</span>, which
        recomputes every row for your tenant from the genesis hash. This console never decides
        the verdict itself.
      </p>
    </div>
  );
}

function AuditRow({
  entry,
  selected,
  onSelect,
}: {
  entry: AuditEntryOut;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "true" : undefined}
        className={`gv-row grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left ${
          selected ? "bg-navy-tint" : ""
        }`}
      >
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="gv-id text-navy">#{entry.seq}</span>
          <span className="truncate font-mono text-[12.5px] font-medium text-ink">
            {entry.action}
          </span>
        </span>
        <Chip tone={actorTone(entry.actor_type)}>{entry.actor_type}</Chip>
        <span className="col-span-2 flex flex-wrap gap-x-4 gap-y-0.5 text-[11.5px]">
          <span className="font-mono text-ink-3">{formatDateTimeIst(entry.recorded_at)}</span>
          <span className="truncate text-ink-3">{entry.actor_id}</span>
          <span className="font-mono text-ink-2">
            {entry.entity_type}/{entry.entity_id}
          </span>
          <span className="font-mono text-ink-4">{shortHash(entry.hash, 8)}</span>
        </span>
      </button>
    </li>
  );
}

function Detail({
  term,
  mono,
  children,
}: {
  term: string;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[12px]" : ""}`}>{children}</dd>
    </>
  );
}

function RowSkeletons() {
  return (
    <ul aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <li key={index} className="gv-row grid gap-2 px-4 py-3">
          <Skeleton h={13} w="min(50%, 300px)" />
          <Skeleton h={11} w="min(75%, 440px)" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Whether a link in the strip is proven, broken, or simply unverified.
 *
 * Unverified is the honest default: until someone presses Verify, this console
 * has recomputed nothing, and colouring the strip green on arrival would assert
 * an integrity check that never ran.
 */
function linkState(
  entry: AuditEntryOut,
  verdict: ChainVerificationOut | null,
): "ok" | "bad" | "plain" {
  if (!verdict) return "plain";
  if (verdict.ok || verdict.first_bad_seq === null) return "ok";
  return entry.seq >= verdict.first_bad_seq ? "bad" : "ok";
}

function actorTone(actorType: string): Tone {
  if (actorType === "agent") return "teal";
  if (actorType === "user") return "navy";
  return "slate";
}
