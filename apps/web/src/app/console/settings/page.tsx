"use client";

import Link from "next/link";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { Chip, Eyebrow, Skeleton, type Tone } from "@/components/console/primitives";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/Field";
import { API_BASE, API_ENV, api } from "@/lib/api";
import { formatDateTimeIst } from "@/lib/format";
import { inspectToken, useSessionLabel, useToken } from "@/lib/session";
import { useConnection } from "@/lib/useResource";

/**
 * Settings — how this browser is connected, and the preferences that are the
 * reader's own rather than the platform's.
 *
 * This page briefly held Administration too, on the argument that both were
 * read-only facts about a deployment. They are not the same question. Settings
 * answers "why is my console behaving like this?", and the answer is about the
 * person in front of it: their token, their connection, their display
 * preferences. How the deployment is configured — tenants, people, credentials,
 * prompt versions, rate cards, connectors and the state of the system — is the
 * same answer for everybody and now lives on Administration, where it can be
 * found by somebody who is not debugging their own session.
 *
 * Nothing on this page writes configuration to the API, and nothing claims to.
 * The token and the display label are written to this browser's localStorage
 * and nowhere else; the connection panel only reads. A save button that cannot
 * save is worse than no button.
 */

const SECTIONS = [
  { id: "connection", label: "Connection" },
  { id: "preferences", label: "Preferences" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export default function SettingsPage() {
  const [token, setToken] = useToken();
  const [label, setLabel] = useSessionLabel();
  const [section, setSection] = useState<SectionId>("connection");
  const [draft, setDraft] = useState("");
  const [labelDraft, setLabelDraft] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [labelMessage, setLabelMessage] = useState<string | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const connection = useConnection();

  useEffect(() => {
    setDraft(token ?? "");
  }, [token]);

  useEffect(() => {
    setLabelDraft(label ?? "");
  }, [label]);

  const claims = inspectToken(token);

  const save = () => {
    const trimmed = draft.trim();
    setToken(trimmed || null);
    setMessage(trimmed ? "Token saved to this browser." : "Token cleared from this browser.");
    setProbe(null);
  };

  const test = () => {
    setProbing(true);
    setProbe(null);
    const candidate = draft.trim() || null;
    void api.listAgents(candidate).then((result) => {
      setProbing(false);
      if (result.ok) {
        setProbe({ ok: true, text: `Accepted. /v1/agents returned ${result.data.length} agents.` });
      } else {
        setProbe({
          ok: false,
          text: `Rejected: ${result.message}${result.status ? ` (HTTP ${result.status})` : ""}`,
        });
      }
    });
  };

  const saveLabel = () => {
    const trimmed = labelDraft.trim();
    setLabel(trimmed || null);
    setLabelMessage(
      trimmed
        ? `Saved. The console header will read “${trimmed}”.`
        : "Cleared. The header falls back to the tenant id carried by your token.",
    );
  };

  /**
   * Arrow keys move between sections, as a tab strip is required to.
   *
   * `role="tablist"` promises a screen-reader user one control; without this
   * the buttons behave as several, and the roving `tabIndex` below is the other
   * half of the same promise.
   */
  const onSectionKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = SECTIONS.findIndex((item) => item.id === section);
    let next: number;
    if (event.key === "ArrowLeft") next = (index - 1 + SECTIONS.length) % SECTIONS.length;
    else if (event.key === "ArrowRight") next = (index + 1) % SECTIONS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    else return;

    event.preventDefault();
    const target = SECTIONS[next];
    setSection(target.id);
    document.getElementById(`settings-tab-${target.id}`)?.focus();
  };

  return (
    <div className="gv-rise space-y-6">
      <header className="min-w-0">
        <Eyebrow>Console · Settings</Eyebrow>
        <h1 className="gv-page-title mt-1.5">Settings</h1>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-ink-2">
          How this browser is connected to the API, and the preferences that belong to you rather
          than to the platform. The token stays in this browser and is attached directly to API
          calls — no server route proxies it, so it is never written to a server log.
        </p>
      </header>

      <div>
        <p id="settings-section-label" className="gv-eyebrow">
          Section
        </p>
        <div
          role="tablist"
          aria-labelledby="settings-section-label"
          aria-orientation="horizontal"
          onKeyDown={onSectionKey}
          className="mt-1.5 flex gap-0.5 overflow-x-auto border-b border-line-2"
        >
          {SECTIONS.map((item) => {
            const on = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                id={`settings-tab-${item.id}`}
                aria-selected={on}
                aria-controls="settings-panel"
                tabIndex={on ? 0 : -1}
                onClick={() => setSection(item.id)}
                className={`box-border inline-flex h-10 shrink-0 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand ${
                  on ? "border-navy text-ink" : "border-transparent text-ink-3 hover:text-ink"
                }`}
              >
                {item.label}
              </button>
            );
          })}
        </div>
      </div>

      <div
        role="tabpanel"
        id="settings-panel"
        aria-labelledby={`settings-tab-${section}`}
        tabIndex={0}
        className="space-y-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
      >
        {section === "connection" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
            <Card
              title="API token"
              description="A bearer token for the tenant you want to operate. In local development, mint one with scripts/dev_token.py."
            >
              <TextField
                label="Bearer token"
                value={draft}
                onChange={setDraft}
                type="password"
                mono
                placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…"
                hint="Stored in localStorage under gravai.console.token. Clearing the field and saving removes it."
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={save}>
                  Save token
                </Button>
                <Button size="sm" onClick={test} disabled={probing}>
                  {probing ? "Testing…" : "Test against /v1/agents"}
                </Button>
                {token ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft("");
                      setToken(null);
                      setMessage("Token cleared from this browser.");
                      setProbe(null);
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>

              {/* The live region is mounted for the life of the page rather than
                  created along with its first message. Assistive technology
                  announces a live region by comparing it against what it held a
                  moment ago, and a region that did not exist a moment ago has
                  nothing to be compared against, so a confirmation that arrives
                  inside a brand-new `role="status"` element is often not read at
                  all. These two lines are the only feedback either button gives,
                  which makes that silence the difference between a save that
                  happened and one a keyboard user has no way of knowing
                  happened. */}
              <div role="status" aria-live="polite">
                {message ? (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                    {/* Green because this is an outcome — the write to this
                        browser proceeded. Navy is reserved for a value that code
                        computed with a fixed answer, which a confirmation is
                        not. */}
                    <Chip tone="green">Saved</Chip>
                    {message}
                  </p>
                ) : null}
                {probing ? (
                  <div className="mt-3">
                    <Skeleton h={14} w="min(60%, 300px)" />
                    <span className="sr-only">
                      Testing this token against /v1/agents…
                    </span>
                  </div>
                ) : probe ? (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                    <Chip tone={probe.ok ? "green" : "red"}>
                      {probe.ok ? "Accepted" : "Rejected"}
                    </Chip>
                    {probe.text}
                  </p>
                ) : null}
              </div>

              <div className="mt-6">
                <Eyebrow>Mint a development token</Eyebrow>
                <pre className="mt-2 overflow-x-auto rounded-md border border-line-2 bg-surface-2 p-3 font-mono text-[11.5px] leading-relaxed text-ink-2">
                  {`uv run python scripts/dev_token.py \\
  --tenant acme --role underwriter`}
                </pre>
                <p className="mt-2 text-[12px] leading-relaxed text-ink-3">
                  The API validates HS256 tokens signed with AUTH_DEV_SECRET while OIDC_JWKS_URL
                  is empty. Setting that variable switches validation to RS256 against the
                  provider&apos;s keys and refuses the development path outright.
                </p>
              </div>
            </Card>

            <div className="space-y-4">
              <Card title="Connection">
                <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
                  <Detail term="API base" mono>
                    {API_BASE}
                  </Detail>
                  <Detail term="Environment" mono>
                    {API_ENV}
                  </Detail>
                  <Detail term="Status">
                    <Chip tone={connectionTone(connection.status)}>{connection.status}</Chip>
                  </Detail>
                  <Detail term="Last checked" mono>
                    {connection.checkedAt ? formatDateTimeIst(connection.checkedAt) : "—"}
                  </Detail>
                  {connection.readiness ? (
                    <>
                      <Detail term="Database" mono>
                        {connection.readiness.checks.database.dialect} · RLS{" "}
                        {connection.readiness.checks.database.row_level_security ? "on" : "off"}
                      </Detail>
                      <Detail term="AI sandbox" mono>
                        {connection.readiness.mode.sarvam_sandbox ? "sandbox" : "live"}
                      </Detail>
                    </>
                  ) : null}
                </dl>
                <div className="mt-3">
                  <Button size="sm" onClick={connection.recheck}>
                    Re-check
                  </Button>
                </div>
                <p className="mt-3 text-[12px] leading-relaxed text-ink-3">
                  The full readiness report, and what it does and does not cover, is on{" "}
                  <Link href="/console/admin" className="gv-link">
                    Administration
                  </Link>{" "}
                  under System status.
                </p>
              </Card>

              <Card
                title="Token claims"
                description="Read locally for display only. The API validates the signature; this console never does."
              >
                {claims ? (
                  <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
                    <Detail term="Subject" mono>
                      {claims.subject ?? "—"}
                    </Detail>
                    <Detail term="Tenant" mono>
                      {claims.tenantId ?? "—"}
                    </Detail>
                    <Detail term="Roles">
                      <TagList values={claims.roles ?? []} />
                    </Detail>
                    <Detail term="Scopes">
                      <TagList values={claims.scopes ?? []} />
                    </Detail>
                    <Detail term="Expires" mono>
                      <span className="flex flex-wrap items-center gap-2">
                        {claims.expiresAt ? formatDateTimeIst(claims.expiresAt) : "—"}
                        {claims.expired ? <Chip tone="red">Expired</Chip> : null}
                      </span>
                    </Detail>
                  </dl>
                ) : (
                  <p className="py-6 text-center text-[13px] leading-relaxed text-ink-3">
                    {token
                      ? "This token is not a readable JWT, which is fine — the API is the authority on whether it is valid."
                      : "No token is set, so there are no claims to read. Paste one above to connect this console."}
                  </p>
                )}
              </Card>

              <Card title="What the console does without a token">
                <ul className="space-y-2 text-[12.5px] leading-relaxed text-ink-2">
                  <li className="border-l-2 border-warn pl-3">
                    Every screen still renders, and every one of them is empty. Nothing is
                    substituted for the data the API would have returned.
                  </li>
                  <li className="border-l-2 border-warn pl-3">
                    That is deliberate. This is a lending-compliance console: a screen of
                    plausible applications, risk bands or audit entries that nothing produced
                    would eventually be screenshotted, quoted, or believed.
                  </li>
                  <li className="border-l-2 border-warn pl-3">
                    Endpoints that have not shipped yet return 404, which renders as a labelled
                    empty state rather than an error — a distinct case from a request that
                    failed.
                  </li>
                </ul>
              </Card>
            </div>
          </div>
        ) : null}

        {section === "preferences" ? (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,23rem)]">
            <Card
              title="Display label for this tenant"
              description="What the console header calls the tenant you are operating, in place of the tenant id."
            >
              <TextField
                label="Tenant label"
                value={labelDraft}
                onChange={setLabelDraft}
                placeholder={claims?.tenantId ?? "Not set"}
                hint="Stored in localStorage under gravai.console.label, on this browser only. It is never sent to the API and it changes nothing about which tenant your token addresses."
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" size="sm" onClick={saveLabel}>
                  Save label
                </Button>
                {label ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setLabelDraft("");
                      setLabel(null);
                      setLabelMessage(
                        "Cleared. The header falls back to the tenant id carried by your token.",
                      );
                    }}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              {/* Mounted empty for the same reason as the confirmation in the
                  Connection section above: a live region has to exist before the
                  text it carries arrives, or the announcement is lost. */}
              <div role="status" aria-live="polite">
                {labelMessage ? (
                  <p className="mt-3 flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2">
                    <Chip tone="green">Saved</Chip>
                    {labelMessage}
                  </p>
                ) : null}
              </div>
              <p className="mt-4 text-[12px] leading-relaxed text-ink-3">
                A tenant id is a UUID, and a header that reads{" "}
                <span className="font-mono text-[11.5px]">3f2a…</span> tells a human nothing —
                least of all which of two open windows is pointed at production. This is
                cosmetic on purpose: it is a note you leave yourself, not a fact about the
                tenant, and the token remains the only thing that decides whose data you see.
              </p>
            </Card>

            <Card title="What else is not here">
              <p className="text-[12.5px] leading-relaxed text-ink-2">
                Theme, density and notification preferences are not offered, because none of them
                is implemented — a switch that moves and changes nothing is a bug with a label on
                it. Anything that configures the deployment rather than your view of it —
                tenants, users and roles, credentials, webhooks, prompt versions, rate cards,
                connectors and system status — is on{" "}
                <Link href="/console/admin" className="gv-link">
                  Administration
                </Link>
                .
              </p>
            </Card>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ---------- Local vocabulary ---------- */

/** A panel with a title, a reason for existing, and an optional control. */
function Card({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="gv-card min-w-0 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-2 px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[15px] font-semibold text-ink">{title}</h2>
          {description ? (
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-3">
              {description}
            </p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function TagList({ values }: { values: string[] }) {
  if (values.length === 0) return <span className="text-ink-3">—</span>;
  return (
    <>
      {values.map((value) => (
        <span key={value} className="gv-chip gv-chip-outline font-mono text-[11px]">
          {value}
        </span>
      ))}
    </>
  );
}

function Detail({ term, mono, children }: { term: string; mono?: boolean; children: ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{term}</dt>
      <dd className={`min-w-0 break-words ${mono ? "font-mono text-[12px]" : ""}`}>{children}</dd>
    </>
  );
}

function connectionTone(status: "checking" | "connected" | "unreachable" | "no-token"): Tone {
  if (status === "connected") return "green";
  if (status === "unreachable") return "red";
  if (status === "no-token") return "amber";
  return "slate";
}
