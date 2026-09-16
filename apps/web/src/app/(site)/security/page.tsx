import type { Metadata } from "next";
import { Icon, type IconName } from "@/components/icons/AgentIcon";
import { Band, PageHeader } from "@/components/site/Page";
import { Badge, Chip } from "@/components/ui/Badge";
import { Arrow, ButtonLink } from "@/components/ui/Button";
import { Card, Cells, SectionHeading } from "@/components/ui/Surface";
import { COMPLIANCE_CONTROLS } from "@/lib/platform";

export const metadata: Metadata = {
  title: "Security and compliance",
  description:
    "GravAI security controls and compliance mapping: RBI Digital Lending Directions, DPDP Act 2023, Account Aggregator, UIDAI Aadhaar masking, collections conduct and calling hours, payments and model risk governance.",
};

const SECURITY_CONTROLS = [
  {
    group: "Identity and access",
    items: [
      "OIDC with MFA enforced at the identity provider; no local password store exists",
      "Eight roles from tenant_admin to auditor, each mapped to a fixed scope set",
      "Approval scopes are deliberately narrow: only an underwriter or credit head may approve, never a collections role",
      "API keys and MCP clients carry their own scopes, tool-set profile, last-used timestamp and rotation state",
    ],
  },
  {
    group: "Tenant isolation",
    items: [
      "PostgreSQL row-level security policy on every table, plus a service-layer tenant guard",
      "A cross-tenant read reports as missing, never as forbidden — a 403 would confirm the record exists",
      "A test suite that attempts cross-tenant reads and must fail",
      "The audit chain is per tenant, so activity volume does not leak between them",
    ],
  },
  {
    group: "Data protection",
    items: [
      "Field-level encryption for PII with an envelope scheme: KEK in Key Vault, a data key per tenant",
      "Aadhaar masked to the last four digits at extraction; the full value is never stored, logged or emitted",
      "Masked views for borrower records; a PII access log records who viewed what",
      "TLS everywhere; private networking for database, cache and Temporal",
      "SSRF-safe document fetch against an allowlist of blob domains, and virus scanning on upload",
    ],
  },
  {
    group: "Agent-specific threats",
    items: [
      "Prompt injection via documents and tool results: data and instructions are separated, outputs are validated, tools are allowlisted per agent",
      "MCP confused deputy and token passthrough: tokens are audience-bound and never forwarded downstream",
      "Over-privileged tools: read and write annotations plus role-scoped tool sets",
      "Exfiltration through model output: PII validators run on every output before it leaves the agent",
      "Model supply chain: pinned model ids, hashed prompts, versioned scorecards",
    ],
  },
  {
    group: "Change and model governance",
    items: [
      "Prompt versions are diffed, evaluated and promoted with approval; rollback is a documented runbook",
      "Scorecards are versioned with published feature weights and a calibration table; PSI computed monthly",
      "Eval gates block promotion in CI on any prompt change",
      "Drift monitoring compares weekly production samples against human-labelled thresholds",
    ],
  },
];

/** One icon per control group, in the order the groups are declared. */
const GROUP_ICONS: IconName[] = ["shield", "database", "file", "activity", "sliders"];

/** The four postures a lender asks about before anything else. */
const POSTURE = [
  {
    label: "Data residency",
    value: "India regions only",
    note: "Azure Central India / South India. Architecture, not a region flag.",
  },
  {
    label: "Aadhaar",
    value: "Masked at extraction",
    note: "Last four digits. The full value is never stored, logged or emitted.",
  },
  {
    label: "Tenant isolation",
    value: "RLS + service guard",
    note: "A policy in the database and a guard above it. Either alone fails quietly.",
  },
  {
    label: "Audit log",
    value: "Append-only, chained",
    note: "Hash-chained per tenant, recomputable from the genesis hash.",
  },
];

/** The rules the voice agent physically cannot break. */
const COLLECTIONS_RULES = [
  "Outside 08:00–19:00 IST the call is not placed. The window is tenant configuration, and the check is in the workflow, before dialling.",
  "The DND and UCC registry is checked before every outbound attempt.",
  "The first turn discloses the lender, that the caller is an AI assistant, and that the call is recorded. Speech analytics scores that disclosure on every call afterwards.",
  "Identity is verified by date of birth or the last four digits of the registered mobile. Never by Aadhaar.",
  "A harassment-language classifier blocks output before synthesis. Three unanswered attempts in a day ends the day.",
];

/** What the audit explorer and the decision trail actually hand over. */
const EVIDENCE_ROWS = [
  { term: "Filter by", value: "Actor · action · entity · time" },
  { term: "Each event", value: "Full payload with its evidence hashes" },
  { term: "On demand", value: "Chain recomputed, first bad sequence named" },
  { term: "Per application", value: "Every agent step, prompt version and citation" },
];

/** The permitted calling window, 08:00–19:00 IST, as a share of the 24-hour day. */
const WINDOW_START_PCT = ((8 / 24) * 100).toFixed(3);
const WINDOW_END_PCT = ((19 / 24) * 100).toFixed(3);
const WINDOW_WIDTH_PCT = (((19 - 8) / 24) * 100).toFixed(3);

export default function SecurityPage() {
  const totalControls = SECURITY_CONTROLS.reduce((count, group) => count + group.items.length, 0);

  return (
    <>
      <PageHeader
        eyebrow="Security and compliance"
        title="Controls that are code, not policy documents"
        lede={
          <>
            A calling window is enforced by the workflow, not by a line in a prompt. Aadhaar is
            masked at the point of extraction, not at the point of display. Consent is scoped
            per purpose and checked at the feature level. Where a control cannot be enforced in
            code, this page says so.
          </>
        }
        actions={
          <>
            <ButtonLink href="#compliance" variant="primary" size="lg">
              The compliance mapping
              <Arrow />
            </ButtonLink>
            <ButtonLink href="/console/audit" size="lg">
              Audit explorer
            </ButtonLink>
          </>
        }
        aside={
          <div className="rounded-xl border border-amber-border bg-amber-soft p-5">
            <p className="gv-eyebrow flex items-center gap-2 text-amber-strong">
              <span aria-hidden="true">
                <Icon name="warning" size={14} />
              </span>
              Read this the right way
            </p>
            <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
              This is a map of implemented controls against regulatory regimes. It is not a
              legal opinion, and it is not a certification. Regulatory text changes; each
              mapping below carries the obligation to verify the current text before a
              deployment.
            </p>
          </div>
        }
      />

      {/* ------------------------------------------------------------------
          The four postures a lender asks about first, as a status row.
         ------------------------------------------------------------------ */}
      <Band tone="white" size="sm">
        <Cells columns={4} raised as="dl">
          {POSTURE.map((item) => (
            <div key={item.label} className="p-5">
              <dt className="gv-eyebrow">{item.label}</dt>
              <dd>
                <p className="mt-2 text-[15.5px] leading-snug font-semibold text-ink">
                  {item.value}
                </p>
                <p className="gv-help mt-2 leading-relaxed">{item.note}</p>
                <p className="mt-3 inline-flex items-center gap-2 text-[12px] font-medium text-pass">
                  <span className="gv-pip" aria-hidden="true" />
                  Enforced in code
                </p>
              </dd>
            </div>
          ))}
        </Cells>
      </Band>

      {/* ------------------------------------------------------------------
          The compliance mapping. An index on the left, a panel per regime.
         ------------------------------------------------------------------ */}
      <Band tone="soft" size="lg" id="compliance" className="scroll-mt-16">
        <SectionHeading
          eyebrow="Compliance mapping"
          title="Seven regimes, and what GravAI does about each"
          lede="Each regime lists the controls that exist in the platform today. Where a control depends on something outside the software, it is named as a dependency rather than written as a claim."
          size="lg"
        />

        <div className="mt-10 grid gap-8 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] lg:gap-10">
          <nav aria-label="Regimes" className="min-w-0 lg:sticky lg:top-24 lg:self-start">
            <div className="gv-panel overflow-hidden">
              <header className="gv-toolbar">
                <h3 className="text-[13.5px] font-semibold text-ink">Regimes</h3>
                <Chip>{COMPLIANCE_CONTROLS.length}</Chip>
              </header>
              <ol className="gv-divide">
                {COMPLIANCE_CONTROLS.map((regime, index) => (
                  <li key={regime.id}>
                    <a
                      href={`#regime-${regime.id}`}
                      className="flex items-baseline gap-3 px-4 py-2.5 text-[13px] leading-snug text-ink-2 no-underline transition-colors duration-150 ease-gv hover:bg-brand-50 hover:text-brand"
                    >
                      <span className="font-mono text-[11px] text-ink-3" data-numeric="">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <span className="min-w-0">{regime.regime}</span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>
          </nav>

          <div className="min-w-0 space-y-4">
            {COMPLIANCE_CONTROLS.map((regime, index) => (
              <section
                key={regime.id}
                id={`regime-${regime.id}`}
                className="gv-panel scroll-mt-24 overflow-hidden"
              >
                <header className="gv-toolbar">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="gv-icon-plate gv-icon-plate-sm font-mono text-[11.5px] font-semibold"
                      data-numeric=""
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <h3 className="text-[15.5px] leading-tight text-ink">{regime.regime}</h3>
                  </div>
                  <Chip tone="brand">
                    {regime.controls.length}{" "}
                    {regime.controls.length === 1 ? "control" : "controls"}
                  </Chip>
                </header>
                <ul className="gv-checklist gv-support p-5 sm:p-6">
                  {regime.controls.map((control) => (
                    <li key={control} className="last:mb-0">
                      {control}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The control register: one instrument, five rows.
         ------------------------------------------------------------------ */}
      <Band tone="white" pattern="grid" size="lg" id="controls">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] lg:gap-12">
          <SectionHeading
            eyebrow="Security controls"
            title="Five groups, from identity to model governance"
            size="lg"
          />
          <p className="gv-support gv-measure self-end">
            The register below is the whole surface: who can act, what stays separated, what is
            encrypted, what an agent can be tricked into doing, and what has to pass before a
            prompt or a scorecard is allowed to change.
          </p>
        </div>

        <div className="gv-panel mt-10 overflow-hidden">
          <header className="gv-toolbar">
            <h3 className="text-[13.5px] font-semibold text-ink">Control register</h3>
            <span className="gv-micro" data-numeric="">
              {totalControls} controls · {SECURITY_CONTROLS.length} groups
            </span>
          </header>
          <div className="gv-divide">
            {SECURITY_CONTROLS.map((group, index) => (
              <div
                key={group.group}
                className="grid gap-x-8 gap-y-4 p-5 sm:p-6 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]"
              >
                <div className="min-w-0">
                  <span className="gv-icon-plate" aria-hidden="true">
                    <Icon name={GROUP_ICONS[index]} size={18} />
                  </span>
                  <h4 className="mt-3.5 text-[15.5px] leading-tight font-semibold text-ink">
                    {group.group}
                  </h4>
                  <p className="gv-micro mt-1.5" data-numeric="">
                    {group.items.length} controls
                  </p>
                </div>
                <ul className="gv-checklist gv-support min-w-0">
                  {group.items.map((item) => (
                    <li key={item} className="last:mb-0">
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The honest gap, and the conduct rules that are not a gap at all.
         ------------------------------------------------------------------ */}
      <Band tone="tint" size="lg" id="honest-gaps">
        <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
          <div className="min-w-0 rounded-xl border border-amber-border bg-amber-soft p-6 sm:p-7">
            <div className="flex flex-wrap items-center gap-3">
              <p className="gv-eyebrow text-amber-strong">The one genuine capability gap</p>
              <Badge tone="amber" dot>
                external dependency
              </Badge>
            </div>
            <h2 className="mt-3 text-[20px] leading-tight">
              Account Aggregator needs a licence
            </h2>
            <p className="mt-4 text-[13.5px] leading-relaxed text-ink-2">
              GravAI defines the AA interface and the ReBIT consent-artefact shape, and ships a
              sandbox adapter. Fetching real data requires an agreement with a
              Sahamati-certified Account Aggregator or TSP, plus FIU registration. That is a
              tenant onboarding step and a commercial one.
            </p>
            <p className="mt-3 text-[13.5px] leading-relaxed text-ink-2">
              It is deliberately not faked. The connector registry reports it as{" "}
              <code className="gv-code">external_dependency</code>, and the console&apos;s
              connector panel says the same thing, so nobody can claim an AA integration that
              nobody checked.
            </p>
          </div>

          <div className="gv-panel min-w-0 overflow-hidden">
            <header className="gv-toolbar">
              <div className="min-w-0">
                <p className="gv-eyebrow">Collections conduct, in detail</p>
                <h2 className="mt-1 text-[16px] leading-tight text-ink">
                  The rules the voice agent physically cannot break
                </h2>
              </div>
              <span className="inline-flex items-center gap-2 text-[12px] font-medium text-ink-2">
                <span className="gv-pip gv-pip-brand" aria-hidden="true" />
                In the workflow
              </span>
            </header>

            <div className="p-5 sm:p-6">
              <div className="gv-well p-4">
                <p className="gv-eyebrow mb-3">Permitted calling window · IST</p>
                <div
                  className="relative h-8 w-full overflow-hidden rounded-md border border-line bg-surface"
                  role="img"
                  aria-label="Calls are placed only between 08:00 and 19:00 India Standard Time."
                >
                  <span
                    aria-hidden="true"
                    className="absolute inset-y-0 border-x-2 border-brand"
                    style={{
                      left: `${WINDOW_START_PCT}%`,
                      width: `${WINDOW_WIDTH_PCT}%`,
                      background: "rgb(var(--gv-brand-rgb) / 0.10)",
                    }}
                  />
                </div>
                <div className="relative mt-2 h-4" aria-hidden="true">
                  <span className="gv-micro absolute left-0">00:00</span>
                  <span
                    className="gv-micro absolute"
                    style={{ left: `${WINDOW_START_PCT}%`, transform: "translateX(-50%)" }}
                  >
                    08:00
                  </span>
                  <span
                    className="gv-micro absolute"
                    style={{ left: `${WINDOW_END_PCT}%`, transform: "translateX(-50%)" }}
                  >
                    19:00
                  </span>
                  <span className="gv-micro absolute right-0">24:00</span>
                </div>
                <p className="gv-micro mt-3">
                  Tenant configuration. Checked in the workflow, before dialling.
                </p>
              </div>

              <ul className="gv-divide mt-5">
                {COLLECTIONS_RULES.map((rule) => (
                  <li key={rule} className="flex gap-3 py-3 first:pt-0 last:pb-0">
                    <span className="mt-0.5 shrink-0 text-brand" aria-hidden="true">
                      <Icon name="check" size={13} />
                    </span>
                    <span className="text-[13.5px] leading-relaxed text-ink-2">{rule}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </Band>

      {/* ------------------------------------------------------------------
          The one inverse band on this page: evidence.
         ------------------------------------------------------------------ */}
      <Band tone="inverse" pattern="radial-center" size="lg" id="evidence">
        <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] lg:gap-14">
          <div className="min-w-0">
            <p className="gv-eyebrow mb-4">The audit trail</p>
            <h2 className="gv-heading text-white">
              An audit asks for evidence, not assurance.
            </h2>
            <p className="gv-lede mt-5 max-w-2xl">
              The audit explorer filters by actor, action, entity and time, shows the full event
              with its evidence hashes, and recomputes the tenant&apos;s hash chain on demand —
              reporting the first sequence number that does not follow. Per application, the
              decision trail prints every agent step, prompt version, citation and human action
              as an annexure to the memorandum.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <ButtonLink href="/console/audit" variant="primary" size="lg">
                Audit explorer
                <Arrow />
              </ButtonLink>
              <ButtonLink href="/docs/compliance" size="lg">
                Compliance docs
              </ButtonLink>
            </div>
          </div>

          <Card className="gv-card-inverse min-w-0 overflow-hidden p-0">
            <p className="gv-eyebrow border-b border-white/15 px-5 py-3">What you get handed</p>
            <dl className="gv-divide">
              {EVIDENCE_ROWS.map((row) => (
                <div key={row.term} className="px-5 py-3.5">
                  <dt className="gv-label">{row.term}</dt>
                  <dd className="mt-1 text-[13.5px] leading-snug font-medium text-white">
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        </div>
      </Band>
    </>
  );
}
