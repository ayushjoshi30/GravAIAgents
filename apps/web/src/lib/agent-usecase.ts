/**
 * The worked example shown on each agent page.
 *
 * This is the "what did it actually do" panel: a short product flow — who
 * arrived, what the platform did, what came back — ending in the agent's real
 * output.
 *
 * Every quoted value below is copied from `agent-samples.json`, which
 * `scripts/generate_agent_samples.py` writes by running all fourteen agents
 * against the sandbox. They are transcribed here rather than read out of the
 * JSON at runtime because the JSON is a full output dump and a page needs the
 * two or three facts that matter, chosen per agent.
 *
 * Transcription is a drift risk, so `tests/test_usecase_figures.py` fails if a
 * figure quoted here stops appearing in the generated samples. If that test
 * fails, the agent changed: update the flow, do not edit the sample.
 */

/** The demo borrower. One persona across every agent, so the flows read as one story. */
export const DEMO_PERSONA = {
  name: "Ayush Joshi",
  /** Initials are the avatar fallback; see UseCaseFlow. */
  initials: "AJ",
  applicationId: "18302",
} as const;

export type FlowTone = "pass" | "amber" | "fail" | "plain";

export type FlowRow = {
  label: string;
  value: string;
  tone?: FlowTone;
  /** Document id and page a value was read from, where one exists. */
  cite?: string;
};

export type FlowNode =
  | {
      kind: "actor";
      name: string;
      /** One line of context — what this person brought with them. */
      context: string;
    }
  | {
      kind: "event";
      label: string;
      detail?: string;
      tone?: FlowTone;
    }
  | {
      kind: "result";
      eyebrow: string;
      headline?: { label: string; value: string; tone?: FlowTone };
      rows: FlowRow[];
    };

export interface AgentUseCase {
  agentId: string;
  /** The situation, in one sentence. */
  scenario: string;
  nodes: FlowNode[];
  /** Measured figures from the run, shown as a strip beneath the flow. */
  proof: { value: string; label: string }[];
  verdict: { kind: "clear" | "escalated"; text: string };
}

const USE_CASES: AgentUseCase[] = [
  {
    agentId: "doc_intelligence",
    scenario:
      "A personal loan application arrives with eight files attached and nothing yet known about what any of them contain.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "8 documents uploaded · 29 pages",
      },
      {
        kind: "event",
        label: "Every file classified against its declared type",
        detail: "0 could not be classified",
        tone: "pass",
      },
      {
        kind: "event",
        label: "Each file routed to extract or digitise",
        detail: "6 extracted, 2 digitised",
      },
      {
        kind: "result",
        eyebrow: "Extracted identity fields",
        rows: [
          { label: "Name", value: "Ayush Joshi", cite: "doc-001 p1" },
          { label: "Aadhaar (last 4)", value: "9017", cite: "doc-001 p1" },
          { label: "PAN", value: "AXKPJ8891L", cite: "doc-002 p1" },
          { label: "Date of birth", value: "02/11/1991", cite: "doc-002 p1" },
          { label: "Unclassified", value: "0.0%", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "98", label: "API calls" },
      { value: "29", label: "pages read" },
      { value: "12", label: "calls per document" },
      { value: "₹26.00", label: "run cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — no escalation" },
  },
  {
    agentId: "bank_statement_analytics",
    scenario:
      "Six months of statement lines have to become an income figure an underwriter can rely on, and an obligation schedule that is not simply the borrower's word.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "13 transactions · opening ₹52,000 · closing ₹5,14,000",
      },
      {
        kind: "event",
        label: "Narrations classified into salary, mandate, bounce and cash",
      },
      {
        kind: "event",
        label: "Opening + credits − debits reconciled against closing",
        detail: "Balances agree",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Income and obligations",
        headline: { label: "Monthly net income", value: "₹85,000.00" },
        rows: [
          { label: "Basis", value: "Median of 6 salary credits" },
          { label: "Income stability", value: "0.989", tone: "pass" },
          { label: "Recurring EMI", value: "₹12,000 · 5 occurrences" },
          {
            label: "Bounces",
            value: "1 · 05/06/2026 insufficient funds",
            tone: "amber",
          },
          { label: "Reconciled", value: "true", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "6", label: "months observed" },
      { value: "13", label: "lines classified" },
      { value: "1", label: "bounce found" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — reconciliation passed" },
  },
  {
    agentId: "aa_data",
    scenario:
      "The same six months of bank data, fetched under a consent artefact instead of being read out of uploaded PDFs.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "1 account linked · HDFC Bank · savings",
      },
      {
        kind: "event",
        label: "Consent artefact checked before anything is fetched",
        detail: "ACTIVE · purpose 105 · 1 of 1 fetch permitted",
        tone: "pass",
      },
      {
        kind: "event",
        label: "Only the consented window requested",
        detail: "19/09/2025 → 14/09/2026",
      },
      {
        kind: "result",
        eyebrow: "Consented financial information",
        headline: { label: "Transactions returned", value: "13" },
        rows: [
          { label: "Account", value: "XXXXXXXX9012 · HDFC Bank" },
          { label: "Consent expires", value: "14/10/2026" },
          { label: "Retention expires", value: "13/03/2027" },
          { label: "Documents needed", value: "0", tone: "pass" },
          { label: "Document API calls avoided", value: "24", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "24", label: "document calls avoided" },
      { value: "13", label: "transactions" },
      { value: "1", label: "fetch used" },
      { value: "₹0.00", label: "run cost" },
    ],
    verdict: {
      kind: "escalated",
      text: "Escalated — sandbox data must not be underwritten",
    },
  },
  {
    agentId: "kyc_verification",
    scenario:
      "The name and date of birth on the application have to be checked against an issuing source, not against the uploaded copies of themselves.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "Application 18302 · DigiLocker linked",
      },
      {
        kind: "event",
        label: "Names normalised past honorifics and ordering",
      },
      {
        kind: "event",
        label: "Aadhaar reduced to last four digits before storage",
        detail: "Full identifier never retained",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Identity cross-check",
        headline: { label: "Checks agreeing", value: "4 of 4", tone: "pass" },
        rows: [
          { label: "Name", value: "exact · 1.0", tone: "pass" },
          { label: "Date of birth", value: "exact · 1.0", tone: "pass" },
          { label: "Aadhaar (last 4)", value: "9017" },
          { label: "PAN", value: "AXKPJ8891L · individual" },
          { label: "Verified", value: "true", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "4/4", label: "checks agree" },
      { value: "1.0", label: "overall score" },
      { value: "0", label: "identifiers stored in full" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — identity verified" },
  },
  {
    agentId: "credit_appraisal",
    scenario:
      "A ₹10,00,000 personal loan over 60 months, to be assessed against the lender's policy using the verified income rather than the declared one.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "₹10,00,000 · 60 months · 11.000%",
      },
      {
        kind: "event",
        label: "EMI and FOIR computed in code from verified figures",
        detail: "P·r·(1+r)ⁿ / ((1+r)ⁿ−1)",
      },
      {
        kind: "event",
        label: "Policy pack evaluated rule by rule",
        detail: "5 rules · 4 pass, 1 not applicable",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Credit memorandum",
        headline: { label: "Proposed EMI", value: "₹21,742.42" },
        rows: [
          { label: "FOIR", value: "39.7% against a 55.0% cap", tone: "pass" },
          { label: "Bureau score", value: "712 ≥ 700", tone: "pass" },
          { label: "Employment vintage", value: "28 months ≥ 6", tone: "pass" },
          { label: "Loan to value", value: "not applicable · no collateral", tone: "amber" },
          { label: "Recommendation", value: "refer", tone: "amber" },
        ],
      },
    ],
    proof: [
      { value: "refer", label: "recommendation" },
      { value: "5", label: "rules evaluated" },
      { value: "2", label: "cross-checks passed" },
      { value: "₹0.46", label: "model cost" },
    ],
    verdict: {
      kind: "escalated",
      text: "Escalated — credit decisions require an underwriter",
    },
  },
  {
    agentId: "risk_scoring",
    scenario:
      "The application needs a default probability that can be reproduced and defended a year from now.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "Bureau 712 · FOIR 0.397 · 1 bounce in 6 months",
      },
      {
        kind: "event",
        label: "Features assembled from verified sources only",
        detail: "7 features · 1 imputed",
      },
      {
        kind: "event",
        label: "Scored by a versioned scorecard, not by a model",
        detail: "scorecard-v1-illustrative",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Risk assessment",
        headline: { label: "P(30+ DPD in 6 months)", value: "6.58%" },
        rows: [
          { label: "Band", value: "AMBER · 6% to 15%", tone: "amber" },
          { label: "Largest driver", value: "FOIR · +1.191", tone: "amber" },
          { label: "Largest offset", value: "Income stability · −1.187", tone: "pass" },
          { label: "Imputed features", value: "ltv", tone: "amber" },
          { label: "Model version", value: "scorecard-v1-illustrative" },
        ],
      },
    ],
    proof: [
      { value: "6.58%", label: "probability" },
      { value: "AMBER", label: "band" },
      { value: "7", label: "features scored" },
      { value: "₹0.36", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — scored and banded" },
  },
  {
    agentId: "msme_underwriting",
    scenario:
      "A thin-file business borrower declares turnover that has to be believed against its GST filings and its bank credits.",
    nodes: [
      {
        kind: "actor",
        name: "Joshi Trading Co.",
        context: "GSTIN 27AAPFU0939F1ZV · 12 monthly returns",
      },
      {
        kind: "event",
        label: "GSTIN checksum validated before anything is read",
        tone: "pass",
      },
      {
        kind: "event",
        label: "GST, bank credits and ITR reconciled against each other",
        detail: "1 discrepancy flagged",
        tone: "amber",
      },
      {
        kind: "result",
        eyebrow: "Turnover assessment",
        headline: { label: "Assessed annual turnover", value: "₹58,00,000" },
        rows: [
          { label: "Basis", value: "Most conservative of the three sources" },
          { label: "Bank to GST ratio", value: "1.00", tone: "pass" },
          { label: "ITR to GST ratio", value: "0.967", tone: "pass" },
          { label: "Seasonality", value: "1.00" },
          {
            label: "Concentration risk",
            value: "0.50 · one buyer is half of inbound",
            tone: "amber",
          },
        ],
      },
    ],
    proof: [
      { value: "12", label: "returns verified" },
      { value: "1", label: "discrepancy flagged" },
      { value: "3", label: "sources reconciled" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — one flag raised" },
  },
  {
    agentId: "onboarding_assistant",
    scenario:
      "An applicant whose file is waiting on documents asks what is happening, and wants an answer rather than a status code.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "“What is happening with my loan application?”",
      },
      {
        kind: "event",
        label: "Application status and pendencies read from the file",
        detail: "pending_documents · 2 outstanding",
      },
      {
        kind: "event",
        label: "Answered only from what the file contains",
        detail: "No commitment on timing or outcome",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Reply sent to the applicant",
        rows: [
          {
            label: "Answer",
            value:
              "Your application is with our credit team. Two documents are still outstanding, and once we receive them the review continues.",
          },
          { label: "Outstanding", value: "Latest 6 months bank statement" },
          { label: "Outstanding", value: "Property valuation report" },
          { label: "Action offered", value: "Upload the outstanding documents" },
          { label: "Handoff required", value: "false", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "2", label: "pendencies surfaced" },
      { value: "1", label: "action offered" },
      { value: "0", label: "claims outside the file" },
      { value: "₹0.49", label: "run cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — answered from file" },
  },
  {
    agentId: "case_allocation",
    scenario:
      "Five delinquent accounts, of which three must not be contacted at all and one needs a person rather than an automated call.",
    nodes: [
      {
        kind: "actor",
        name: "Delinquent portfolio",
        context: "5 cases · ₹1,91,065 overdue",
      },
      {
        kind: "event",
        label: "Suppression applied before ranking, not after",
        detail: "Dispute, do-not-call and live promise",
        tone: "amber",
      },
      {
        kind: "event",
        label: "Remaining cases scored on days past due, exposure and conduct",
      },
      {
        kind: "result",
        eyebrow: "Next best action",
        headline: { label: "Contactable", value: "2 of 5" },
        rows: [
          { label: "Suppressed", value: "3 · with reasons", tone: "amber" },
          {
            label: "C-1003",
            value: "priority 4.1 · human call · ta-IN · 78 dpd",
            tone: "amber",
          },
          { label: "C-1001", value: "priority 1.22 · digital nudge · whatsapp" },
          { label: "Contact window", value: "08:00–19:00 IST" },
        ],
      },
    ],
    proof: [
      { value: "5", label: "cases ranked" },
      { value: "3", label: "suppressed" },
      { value: "2", label: "contactable" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: {
      kind: "escalated",
      text: "Escalated — 1 case needs a human conversation",
    },
  },
  {
    agentId: "smart_mandate",
    scenario:
      "Mandates should be presented when the money is actually there, and never against a promise the borrower is still keeping.",
    nodes: [
      {
        kind: "actor",
        name: "Mandate book",
        context: "5 cases with registered mandates",
      },
      {
        kind: "event",
        label: "Salary credit day found per borrower from statement analysis",
      },
      {
        kind: "event",
        label: "Pre-debit notice issued at least 24 hours ahead",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Presentment plan",
        headline: { label: "To present", value: "₹35,952" },
        rows: [
          { label: "C-1001", value: "02/10/2026 · ₹21,742", tone: "pass" },
          { label: "C-1001 notice", value: "01/10/2026 · 24h ahead", tone: "pass" },
          { label: "C-1004", value: "08/10/2026 · ₹14,210", tone: "pass" },
          {
            label: "C-1002 skipped",
            value: "Promise to pay by 17/09/2026 is live",
            tone: "amber",
          },
          { label: "C-1003 skipped", value: "No active mandate registered", tone: "amber" },
        ],
      },
    ],
    proof: [
      { value: "2", label: "presentments planned" },
      { value: "3", label: "skipped with reason" },
      { value: "24h", label: "minimum notice" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — every plan carries notice" },
  },
  {
    agentId: "voice_collections",
    scenario:
      "A collections call at 11:30 in the morning, where every line has to clear the conduct rules before it is spoken rather than after.",
    nodes: [
      {
        kind: "actor",
        name: DEMO_PERSONA.name,
        context: "Case C-1001 · 8 days past due · en-IN",
      },
      {
        kind: "event",
        label: "Calling window and do-not-call register checked first",
        detail: "11:30 IST, inside 08:00–19:00",
        tone: "pass",
      },
      {
        kind: "event",
        label: "Automated assistant and recording disclosed, identity verified",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Call outcome",
        headline: { label: "Outcome", value: "Promise to pay", tone: "pass" },
        rows: [
          { label: "Promise", value: "₹21,742 due 28/09/2026", tone: "pass" },
          { label: "Confirmed back to borrower", value: "true", tone: "pass" },
          { label: "Lines cleared", value: "5 of 5", tone: "pass" },
          { label: "Prohibited lines blocked", value: "0", tone: "pass" },
          { label: "Handoff required", value: "false", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "5/5", label: "lines cleared" },
      { value: "0", label: "conduct breaches" },
      { value: "1", label: "promise captured" },
      { value: "₹0.45", label: "run cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — call permitted and compliant" },
  },
  {
    agentId: "speech_analytics",
    scenario:
      "The call that just happened has to be scored against a published rubric, with no quote that cannot be found in the transcript.",
    nodes: [
      {
        kind: "actor",
        name: "Call C-1001-call",
        context: "5 transcript lines · en-IN",
      },
      {
        kind: "event",
        label: "Each rubric criterion scored separately",
        detail: "6 criteria · 30 points",
      },
      {
        kind: "event",
        label: "Every quote checked against the transcript verbatim",
        detail: "0 dropped as unverifiable",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Quality score",
        headline: { label: "Call score", value: "83.3%" },
        rows: [
          { label: "Disclosure", value: "5 / 5", tone: "pass" },
          { label: "Courtesy", value: "5 / 5", tone: "pass" },
          { label: "Identity verification", value: "4 / 5" },
          { label: "Objection handling", value: "3 / 5", tone: "amber" },
          { label: "Compliance violations", value: "0", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "83.3%", label: "call score" },
      { value: "0", label: "missing disclosures" },
      { value: "2", label: "coaching notes" },
      { value: "₹0.46", label: "run cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — scored against rubric" },
  },
  {
    agentId: "customer_data_intelligence",
    scenario:
      "A top-up campaign over the existing book, where consent decides who is eligible before any rule is applied.",
    nodes: [
      {
        kind: "actor",
        name: "Existing book",
        context: "9 customers · purpose: marketing",
      },
      {
        kind: "event",
        label: "Anyone without a live marketing consent dropped first",
        detail: "3 excluded",
        tone: "amber",
      },
      {
        kind: "event",
        label: "Four published rules applied to the remainder",
        detail: "No rule references a protected attribute",
        tone: "pass",
      },
      {
        kind: "result",
        eyebrow: "Segments produced",
        headline: { label: "top_up_ready", value: "6 customers" },
        rows: [
          {
            label: "Rule",
            value: "12m on book, 40% repaid, no bounces, not RED",
          },
          { label: "Consent-eligible", value: "6 of 9", tone: "pass" },
          { label: "Excluded, no consent", value: "3", tone: "amber" },
          { label: "pre_delinquency_watch", value: "0 customers" },
          { label: "Protected attributes used", value: "0", tone: "pass" },
        ],
      },
    ],
    proof: [
      { value: "6 of 9", label: "eligible" },
      { value: "4", label: "rules applied" },
      { value: "0", label: "unsegmented" },
      { value: "₹0.00", label: "model cost" },
    ],
    verdict: { kind: "clear", text: "Cleared — purpose limitation enforced" },
  },
  {
    agentId: "ops_research",
    scenario:
      "Before committing to a document volume, someone has to know what it costs in requests and whether the rate ceiling can absorb it.",
    nodes: [
      {
        kind: "actor",
        name: "Capacity question",
        context: "68,976 documents a month · 10 requests per minute",
      },
      {
        kind: "event",
        label: "Request model built endpoint by endpoint",
        detail: "Polling separated from actual work",
      },
      {
        kind: "event",
        label: "Request volume converted into hours against the ceiling",
        tone: "amber",
      },
      {
        kind: "result",
        eyebrow: "Capacity finding",
        headline: { label: "Calls per month", value: "919,570" },
        rows: [
          { label: "Status polling", value: "689,760 · 75.01% of volume", tone: "amber" },
          { label: "Hours required", value: "1,379.5" },
          { label: "Business hours available", value: "176" },
          { label: "Utilisation", value: "7.84× capacity", tone: "fail" },
          { label: "Backlog drain", value: "183.6 days or 2,203.4 days" },
        ],
      },
    ],
    proof: [
      { value: "919,570", label: "calls modelled" },
      { value: "75.01%", label: "is polling" },
      { value: "7.84×", label: "over capacity" },
      { value: "12×", label: "spread on one unknown" },
    ],
    verdict: { kind: "escalated", text: "Escalated — this is a capacity decision" },
  },
];

const BY_ID = new Map(USE_CASES.map((useCase) => [useCase.agentId, useCase]));

/** Every agent in the catalog has one, but the type does not pretend to know that. */
export function getUseCase(agentId: string): AgentUseCase | undefined {
  return BY_ID.get(agentId);
}

export { USE_CASES };
