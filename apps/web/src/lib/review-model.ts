/**
 * View model for the decision workspace.
 *
 * One adapter — `toReviewItem` — turns the API's `TaskOut` into what the screen
 * needs, so that field-name drift lives in exactly one place rather than being
 * spread across a dozen JSX expressions.
 *
 * The design package this was ported from assumes a much richer task payload
 * than the API returns today: rule-by-rule outcomes, an agent latency trail, a
 * call transcript, a run id, a separate approval-matrix result. None of those
 * are on `TaskOut`, so none of them are modelled here. Inventing optional
 * fields that nothing can ever populate would leave the workspace carrying
 * panels that are dead by construction, and would quietly promise an auditor
 * evidence the console cannot show. When the API grows those fields, they get
 * added here and the workspace grows the panel — in that order.
 */
import { api, type ApiResult, type TaskOut } from "@/lib/api";

export type ItemKind = "decision" | "deviation" | "call" | "pendency";
export type Severity = "L1" | "L2" | "L3";
export type ActionKind = "primary" | "danger" | "secondary";

/**
 * The three task resolutions the API actually exposes, as
 * `POST /v1/tasks/{id}/{endpoint}`. Everything the design names beyond these
 * three is carried as `null` and rendered disabled with a reason, because a
 * button that silently does nothing is worse than one that explains itself.
 */
export type TaskEndpoint = "approve" | "reject" | "request_info";

export interface Fact {
  label: string;
  value: string;
  /** The qualifier that makes the figure honest — a cap, a source, a policy. */
  caption?: string;
}

export interface ItemAction {
  label: string;
  kind: ActionKind;
  endpoint: TaskEndpoint | null;
  /** Past tense, for the confirmation once the decision is recorded. */
  past: string;
  /** Set only where `endpoint` is null: the sentence that explains the gap. */
  unavailable?: string;
}

export interface ReviewItem {
  id: string;
  kind: ItemKind;
  severity: Severity | null;
  title: string;
  summary: string;
  /** The application this was raised against; null when the task is unattached. */
  entityId: string | null;
  /**
   * The queue the task sits in, which on this API is also the queue that may
   * sign it — `assigned_to` is the approval matrix's output, not a separate
   * field. Null means unassigned, and an unassigned item cannot be scoped.
   */
  queue: string | null;
  agent: string | null;
  raisedAt: string;
  dueAt: string | null;
  recommendation: { label: string; value: string; tone?: "amber" | "red" } | null;
  facts: Fact[];
  actions: ItemAction[];
}

export const KIND_LABEL: Record<ItemKind, string> = {
  decision: "Decision",
  deviation: "Deviation",
  call: "Call review",
  pendency: "Pendency",
};

const KIND_FROM_TYPE: Record<TaskOut["type"], ItemKind> = {
  decision: "decision",
  deviation: "deviation",
  call_review: "call",
  pendency: "pendency",
};

/**
 * What each severity means for who signs. This is policy, not API data: the
 * approval matrix is the same table the API enforces on write and that
 * `APPROVER_QUEUES` in `lib/session.ts` mirrors for the disabled state. It is
 * restated here in a sentence because "L2" on its own tells a new underwriter
 * nothing about why the button is not theirs to press.
 */
export const SEVERITY_ROUTING: Record<Severity, string> = {
  L1: "the underwriting queue may sign",
  L2: "routes to the credit head",
  L3: "routes to the credit committee",
};

const REQUEST_INFORMATION: ItemAction = {
  label: "Request information",
  kind: "secondary",
  endpoint: "request_info",
  past: "Information requested",
};

/**
 * The verbs offered for each kind of item.
 *
 * Where the design names an action that maps cleanly onto one of the three task
 * resolutions, it is wired to it — "Decline" on a deviation is a reject, and
 * "Confirm finding" on a flagged call is an approve of the finding, not of the
 * call. Where it does not map, the action keeps its place in the row and
 * carries the sentence that says why it cannot fire.
 */
export function actionsFor(kind: ItemKind): ItemAction[] {
  switch (kind) {
    case "decision":
      return [
        { label: "Approve", kind: "primary", endpoint: "approve", past: "Approved" },
        { label: "Reject", kind: "danger", endpoint: "reject", past: "Rejected" },
        REQUEST_INFORMATION,
      ];
    case "deviation":
      return [
        { label: "Approve deviation", kind: "primary", endpoint: "approve", past: "Deviation approved" },
        { label: "Decline", kind: "danger", endpoint: "reject", past: "Deviation declined" },
        REQUEST_INFORMATION,
      ];
    case "call":
      return [
        { label: "Confirm finding", kind: "primary", endpoint: "approve", past: "Finding confirmed" },
        { label: "Dismiss", kind: "danger", endpoint: "reject", past: "Finding dismissed" },
        {
          label: "Send to QA",
          kind: "secondary",
          endpoint: null,
          past: "Sent to QA",
          unavailable:
            "There is no QA routing endpoint yet. Confirm or dismiss the finding here and raise QA out of band.",
        },
      ];
    case "pendency":
      return [
        { label: "Chase the document", kind: "primary", endpoint: "request_info", past: "Information requested" },
        { label: "Close as received", kind: "secondary", endpoint: "approve", past: "Pendency closed" },
        {
          label: "Offer a consent-based fetch",
          kind: "secondary",
          endpoint: null,
          past: "Consent offered",
          unavailable:
            "Consent to fetch the data is offered inside the borrower journey, not from the console. There is no endpoint to trigger it from here.",
        },
      ];
  }
}

/** `recommend_reject` reads as `Recommend reject`, not `Recommend Reject`. */
function sentenceCase(value: string): string {
  const spaced = value.replace(/[_.-]+/g, " ").trim();
  if (!spaced) return value;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Which `detail` key, if any, carries the headline the screen leads with. */
const HEADLINE_KEYS = new Set(["recommendation", "outcome", "decision", "type"]);

/**
 * The API sends `detail` values as one string — "39.7% (cap 50%)". The design
 * wants the figure large and the qualifier small beneath it, so a trailing
 * parenthetical is lifted out as the caption. The guards matter: the split only
 * fires on a short parenthetical with something in front of it, so a quoted
 * call transcript or a value that merely happens to contain brackets is left
 * exactly as the API sent it.
 */
function splitCaption(raw: string): { value: string; caption?: string } {
  const value = raw.trim();
  const match = /^(.{1,}?)\s*\(([^()]{1,40})\)$/.exec(value);
  if (!match) return { value };
  return { value: match[1], caption: match[2] };
}

function toneFor(value: string): "amber" | "red" | undefined {
  if (/reject|fail|breach|decline|adverse/i.test(value)) return "red";
  if (/refer|review|amber|pending/i.test(value)) return "amber";
  return undefined;
}

export function toReviewItem(task: TaskOut): ReviewItem {
  const kind = KIND_FROM_TYPE[task.type] ?? "decision";
  const entries = Object.entries(task.detail ?? {});
  const headline = entries.find(([key]) => HEADLINE_KEYS.has(key.trim().toLowerCase()));

  return {
    id: task.id,
    kind,
    severity: task.severity,
    title: task.title,
    summary: task.summary,
    entityId: task.application_id,
    queue: task.assigned_to,
    agent: task.agent_id,
    raisedAt: task.raised_at,
    dueAt: task.sla_due_at,
    recommendation: headline
      ? { label: sentenceCase(headline[0]), value: sentenceCase(headline[1]), tone: toneFor(headline[1]) }
      : null,
    facts: entries
      .filter((entry) => entry !== headline)
      .map(([label, value]) => ({ label, ...splitCaption(value) })),
    actions: actionsFor(kind),
  };
}

export type SlaState = "ok" | "soon" | "breached" | "none";

/**
 * `now` is a parameter rather than a call to `Date.now()` inside the function
 * on purpose. Every caller has to render the same instant across a whole list,
 * a set of tiles and the workspace beside them, and a function that read the
 * clock itself would let a row say "due in 4h" while the sentence above it said
 * three — the sort of disagreement that makes a reader stop trusting a screen.
 * It also keeps the function pure, so a caller that renders on the server and
 * hydrates on the client can hand it one value and get one answer.
 *
 * The three state names are production's, verbatim: in SLA, due soon, SLA
 * breached. The hours are appended because a countdown is what a person is
 * actually deciding against — "due soon" alone cannot be quoted to a borrower
 * or pasted into a ticket.
 */
export function slaOf(
  dueAt: string | null,
  now: number,
): { state: SlaState; hours: number | null; label: string } {
  if (!dueAt) return { state: "none", hours: null, label: "No SLA" };
  const due = Date.parse(dueAt);
  if (Number.isNaN(due)) return { state: "none", hours: null, label: "No SLA" };
  const hours = Math.round((due - now) / 3_600_000);
  if (hours < 0) return { state: "breached", hours, label: `SLA breached · ${-hours}h` };
  if (hours <= 4) return { state: "soon", hours, label: `Due soon · ${hours}h` };
  return { state: "ok", hours, label: `In SLA · ${hours}h` };
}

/** Soonest first; an item with no SLA sorts behind every item that has one. */
export function bySla(a: ReviewItem, b: ReviewItem): number {
  const left = a.dueAt ? Date.parse(a.dueAt) : Number.POSITIVE_INFINITY;
  const right = b.dueAt ? Date.parse(b.dueAt) : Number.POSITIVE_INFINITY;
  return left - right;
}

/**
 * Other open items raised against the same application.
 *
 * The design calls this panel "Deviations attached" and expects the task
 * payload to carry the children. It does not, so the relationship is recovered
 * from the queue itself by application id — which is the same relationship, and
 * has the advantage of being true. It also catches the case the payload could
 * not: a deviation and its parent decision sitting in two different queues.
 */
export function relatedItems(all: ReviewItem[], item: ReviewItem): ReviewItem[] {
  if (!item.entityId) return [];
  return all.filter((other) => other.id !== item.id && other.entityId === item.entityId);
}

/**
 * Records the decision. The API stores the actor, the time, the entity and the
 * note verbatim, and hashes the event into the audit chain.
 *
 * It returns only `{ id, status }` — no sequence number and no hash — so the
 * workspace must not claim to show the reader their chain entry. It says the
 * event is recorded and points at the audit chain, which is the honest version
 * of the same reassurance.
 */
export function submitDecision(
  token: string | null,
  item: ReviewItem,
  endpoint: TaskEndpoint,
  note: string,
): Promise<ApiResult<{ id: string; status: string }>> {
  return api.actOnTask(token, item.id, endpoint, note);
}
