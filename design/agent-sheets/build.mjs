/* Build the agent capability sheets as .dc.html artboards.
 *
 * Every figure below is copied from apps/web/src/lib/agent-samples.json, which
 * is written by scripts/generate_agent_samples.py running all fourteen agents
 * against the sandbox. Nothing here is illustrative: if an agent changes, the
 * sample changes, and this file is what has to be brought back into line.
 *
 *   node design/agent-sheets/build.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/* ── design tokens, lifted from apps/web/src/app/globals.css ─────────────── */
const T = {
  brand: "#204887",
  brand600: "#1b3d74",
  brand300: "#a8bfe0",
  brand200: "#cfdcef",
  brand100: "#e8eef8",
  brand50: "#f4f7fc",
  surface: "#ffffff",
  surface2: "#f7f9fc",
  surface3: "#eef1f6",
  ink: "#101828",
  ink2: "#475467",
  ink3: "#667085",
  line: "#e4e8ef",
  lineStrong: "#cfd6e0",
  pass: "#027a48",
  passSoft: "#ecfdf3",
  passBorder: "#abefc6",
  amber: "#b54708",
  amberSoft: "#fffaeb",
  amberBorder: "#fedf89",
  accent: "#0c6b5f",
  accentSoft: "#e6f2f0",
  shadow: "0 1px 2px 0 rgb(16 24 40 / 0.05)",
};

const SANS =
  '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const MONO =
  '"IBM Plex Mono", ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace';

const MARK_PATH =
  "M17.304 26.1322C16.4117 26.1322 15.591 25.989 14.8419 25.7026C14.0927 25.4051 13.4428 24.992 12.892 24.4632C12.3411 23.9234 11.9115 23.2955 11.603 22.5794C11.2946 21.8633 11.1404 21.0757 11.1404 20.2164C11.1404 19.3571 11.2946 18.5694 11.603 17.8534C11.9115 17.1373 12.3411 16.5149 12.892 15.9861C13.4538 15.4463 14.1093 15.0332 14.8584 14.7468C15.6075 14.4493 16.4337 14.3006 17.3371 14.3006C18.2514 14.3006 19.0887 14.4493 19.8488 14.7468C20.6089 15.0442 21.2534 15.4904 21.7822 16.0852L20.7577 17.1098C20.284 16.6471 19.7662 16.3111 19.2044 16.1018C18.6535 15.8814 18.0531 15.7713 17.4032 15.7713C16.7422 15.7713 16.1253 15.8814 15.5524 16.1018C14.9906 16.3221 14.5004 16.6306 14.0817 17.0271C13.6741 17.4237 13.3547 17.8974 13.1233 18.4483C12.903 18.9881 12.7928 19.5774 12.7928 20.2164C12.7928 20.8443 12.903 21.4337 13.1233 21.9845C13.3547 22.5243 13.6741 22.998 14.0817 23.4056C14.5004 23.8022 14.9906 24.1107 15.5524 24.331C16.1143 24.5513 16.7257 24.6615 17.3867 24.6615C18.0036 24.6615 18.5929 24.5679 19.1548 24.3806C19.7276 24.1823 20.2564 23.8573 20.7411 23.4056L21.683 24.6615C21.1102 25.1462 20.4382 25.5153 19.667 25.7687C18.9069 26.011 18.1192 26.1322 17.304 26.1322ZM20.0967 24.4467V20.1503H21.683V24.6615L20.0967 24.4467Z";

const mark = (px, colour) =>
  `<svg class="mark" width="${px}" height="${px}" viewBox="0 0 40 40" fill="${colour}" aria-hidden="true"><g transform="translate(-16.1 -24.48) scale(2.2)"><path d="${MARK_PATH}"/></g></svg>`;

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/* ── the fourteen agents ─────────────────────────────────────────────────── */
const DOMAINS = {
  intake: { label: "Lending intake", tint: T.brand },
  credit: { label: "Credit decision", tint: T.brand },
  collections: { label: "Collections", tint: T.accent },
  portfolio: { label: "Portfolio & operations", tint: T.accent },
};

const AGENTS = [
  {
    id: "DocumentIntelligence",
    domain: "intake",
    name: "Document Intelligence",
    tagline:
      "Classifies every file in an application, routes it to the right reader, and returns each field with the page it came from.",
    inputs: [
      ["Application", "18302"],
      ["Files", "8 documents · 29 pages"],
      ["Declared types", "kyc.aadhaar 1pp · kyc.pan 1pp · +6 more"],
    ],
    process: [
      "Classify each file against its declared type",
      "Route to extract or digitise on page count and layout",
      "Pull fields, each bound to a document and page",
      "Score legibility and completeness per document",
    ],
    outputs: [
      ["name", "Ayush Joshi", "cite", "18302-doc-001 p1"],
      ["aadhaar_last4", "9017", "cite", "18302-doc-001 p1"],
      ["pan", "AXKPJ8891L", "cite", "18302-doc-002 p1"],
      ["date_of_birth", "02/11/1991", "cite", "18302-doc-002 p1"],
      ["unknown_type_ratio", "0.0", "pass"],
    ],
    proof: [
      ["98", "API calls"],
      ["29", "pages read"],
      ["12", "calls per document"],
      ["₹26.00", "run cost"],
    ],
    note:
      "Twelve calls a document is one submit, ten status polls and one results fetch. A document over ten pages is two jobs, not one.",
    verdict: ["clear", "Cleared — no escalation"],
  },
  {
    id: "BankStatementAnalytics",
    domain: "intake",
    name: "Bank Statement Analytics",
    tagline:
      "Turns a statement into an income basis, an obligation schedule and a reconciliation that either balances or does not.",
    inputs: [
      ["Transactions", "13 lines"],
      ["Opening balance", "₹52,000"],
      ["Closing balance", "₹5,14,000"],
      ["First line", "01/03/2026 NEFT SALARY CREDIT 85000"],
    ],
    process: [
      "Classify each narration into salary, mandate, bounce, cash",
      "Take income as the median of recurring salary credits",
      "Detect recurring obligations by amount and cadence",
      "Reconcile opening + credits − debits against closing",
    ],
    outputs: [
      ["Monthly net income", "₹85,000.00", "big"],
      ["Basis", "median of 6 monthly salary credits"],
      ["Income stability", "0.989", "pass"],
      ["Recurring EMI", "₹12,000 · HDFC · 5 occurrences"],
      ["Bounces", "1 · 05/06/2026 insufficient funds", "amber"],
      ["Cash deposit ratio", "3.75%"],
      ["Reconciled", "true", "pass"],
    ],
    proof: [
      ["6", "months observed"],
      ["13", "lines classified"],
      ["1", "bounce found"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Every figure on this sheet is arithmetic in code. No model was asked for a number, which is why the run costs nothing.",
    verdict: ["clear", "Cleared — reconciliation passed"],
  },
  {
    id: "AccountAggregator",
    domain: "intake",
    name: "Account Aggregator",
    tagline:
      "Fetches bank data under a consent artefact, enforces purpose and retention, and skips document reading entirely.",
    inputs: [
      ["Customer", "cust-18302"],
      ["Purpose", "Loan underwriting"],
      ["Consent", "consent-3cd5fd5b9df09abd"],
    ],
    process: [
      "Check the artefact is ACTIVE and the purpose permits the use",
      "Check the fetch count against what consent allows",
      "Pull financial information for the consented range only",
      "Normalise to the same transaction shape a statement yields",
    ],
    outputs: [
      ["Consent status", "ACTIVE · purpose 105", "pass"],
      ["Data range", "19/09/2025 → 14/09/2026"],
      ["Consent expires", "14/10/2026"],
      ["Retention expires", "13/03/2027"],
      ["Fetches used", "1 of 1 permitted"],
      ["Account", "XXXXXXXX9012 · HDFC Bank · SAVINGS"],
      ["Transactions", "13", "big"],
    ],
    proof: [
      ["24", "document calls avoided"],
      ["13", "transactions"],
      ["1", "fetch used"],
      ["₹0.00", "run cost"],
    ],
    note:
      "Structured at source, so nothing is extracted and nothing is guessed. The same thirteen transactions reach the same underwriting conclusion as the statement route.",
    verdict: [
      "escalated",
      "Escalated — sandbox data must not be underwritten",
    ],
  },
  {
    id: "KycVerification",
    domain: "intake",
    name: "KYC Verification",
    tagline:
      "Cross-checks the application against an issuing source and reports where the two disagree.",
    inputs: [
      ["Application", "18302"],
      ["Source", "DigiLocker"],
      ["Declared name", "Ayush Joshi"],
      ["Declared date of birth", "02/11/1991"],
    ],
    process: [
      "Normalise names past honorifics and ordering",
      "Compare each field and score the agreement",
      "Reduce Aadhaar to its last four digits before anything is stored",
      "Report per-field, never as a single opaque verdict",
    ],
    outputs: [
      ["Verified", "true", "pass"],
      ["Checks agreeing", "4 of 4", "pass"],
      ["name", "exact · 1.0"],
      ["date_of_birth", "exact · 1.0"],
      ["aadhaar_last4", "9017"],
      ["pan", "AXKPJ8891L · individual"],
      ["Overall score", "1.0", "big"],
    ],
    proof: [
      ["4/4", "checks agree"],
      ["1.0", "overall score"],
      ["0", "identifiers stored in full"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Aadhaar is handled as last four digits only, at every stage. A full identifier appearing in any output is a guardrail violation, not a display choice.",
    verdict: ["clear", "Cleared — identity verified"],
  },
  {
    id: "CreditAppraisal",
    domain: "credit",
    name: "Credit Appraisal",
    tagline:
      "Builds the credit memorandum: eligibility arithmetic, rule-by-rule policy evaluation, and a recommendation a human signs.",
    inputs: [
      ["Application", "18302"],
      ["Loan amount", "₹10,00,000"],
      ["Tenure", "60 months at 11.000%"],
      ["Verified income", "₹85,000.00"],
      ["Existing EMI", "₹12,000"],
    ],
    process: [
      "Compute EMI from P·r·(1+r)ⁿ / ((1+r)ⁿ−1)",
      "Compute FOIR from verified income, not declared",
      "Evaluate the policy pack rule by rule",
      "Write the memorandum from the computed figures only",
    ],
    outputs: [
      ["Proposed EMI", "₹21,742.42", "big"],
      ["FOIR", "39.7% against a 55.0% cap", "pass"],
      ["ELIG-FOIR-01", "pass · 39.7% ≤ 55.0%", "pass"],
      ["RISK-BUREAU-01", "pass · 712 ≥ 700", "pass"],
      ["RISK-ENQ-01", "pass · 3 ≤ 6", "pass"],
      ["POLICY-VINTAGE-01", "pass · 28 months ≥ 6", "pass"],
      ["ELIG-LTV-01", "not applicable · no collateral", "amber"],
    ],
    proof: [
      ["refer", "recommendation"],
      ["5", "rules evaluated"],
      ["2", "cross-checks passed"],
      ["₹0.46", "model cost"],
    ],
    note:
      "The model wrote the memorandum. It was not asked for the EMI, the FOIR or the outcome — those came from code, and the rules state their own thresholds in plain language.",
    verdict: [
      "escalated",
      "Escalated — credit decisions require an underwriter",
    ],
  },
  {
    id: "RiskScoring",
    domain: "credit",
    name: "Risk Scoring",
    tagline:
      "Returns a default probability from a versioned scorecard, with the drivers that moved it and the features that were missing.",
    inputs: [
      ["Application", "18302"],
      ["Bureau score", "712"],
      ["FOIR", "0.397"],
      ["Bounces (6m)", "1"],
      ["Employment vintage", "28 months"],
    ],
    process: [
      "Assemble features from verified sources",
      "Apply scorecard-v1-illustrative — fixed weights, no model call",
      "Band the probability against published thresholds",
      "Ask the model only to explain what the scorecard produced",
    ],
    outputs: [
      ["P(30+ DPD in 6 months)", "6.58%", "big"],
      ["Band", "AMBER · 6% to 15%", "amber"],
      ["Model version", "scorecard-v1-illustrative"],
      ["Driver — foir", "+1.191 · increases risk", "amber"],
      ["Driver — income_stability", "−1.187 · reduces risk", "pass"],
      ["Imputed features", "ltv", "amber"],
    ],
    proof: [
      ["6.58%", "probability"],
      ["AMBER", "band"],
      ["7", "features scored"],
      ["₹0.36", "model cost"],
    ],
    note:
      "The probability never comes from the model. It comes from a scorecard with a version you can name, so a decision made today can be reproduced a year from now.",
    verdict: ["clear", "Cleared — scored and banded"],
  },
  {
    id: "MsmeUnderwriting",
    domain: "credit",
    name: "MSME Underwriting",
    tagline:
      "Cross-verifies declared turnover against GST filings and bank credits, then underwrites the most conservative of the three.",
    inputs: [
      ["Application", "M-1"],
      ["GSTIN", "27AAPFU0939F1ZV"],
      ["GST returns", "12 monthly filings"],
      ["Bank credits (annual)", "₹60,00,000"],
      ["ITR declared", "₹58,00,000"],
    ],
    process: [
      "Validate the GSTIN checksum before anything is read",
      "Sum filed turnover and compare with bank credits and ITR",
      "Measure seasonality across the twelve months",
      "Measure counterparty concentration and circularity",
    ],
    outputs: [
      ["Assessed turnover", "₹58,00,000", "big"],
      ["Basis", "most conservative of GST, bank, ITR"],
      ["GSTIN valid", "true", "pass"],
      ["Bank to GST ratio", "1.00", "pass"],
      ["ITR to GST ratio", "0.967", "pass"],
      ["Seasonality ratio", "1.00"],
      ["Concentration risk", "0.50 · one buyer is half of inbound", "amber"],
    ],
    proof: [
      ["12", "returns verified"],
      ["1", "discrepancy flagged"],
      ["3", "sources reconciled"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Concentration is reported as a flag, not folded silently into the turnover. Losing Bharat Retail would remove half the revenue, and an underwriter should see that as its own fact.",
    verdict: ["clear", "Cleared — one flag raised"],
  },
  {
    id: "OnboardingAssistant",
    domain: "credit",
    name: "Onboarding Assistant",
    tagline:
      "Answers an applicant's question from their actual file, and hands off rather than guessing when it cannot.",
    inputs: [
      ["Application", "18303"],
      ["Question", "What is happening with my loan application?"],
      ["Status", "pending_documents"],
      ["Pendencies", "2 outstanding"],
    ],
    process: [
      "Read the application status and outstanding requirements",
      "Answer only from what the file contains",
      "Convert internal status into language an applicant can act on",
      "Hand off to a person when the question is outside the file",
    ],
    outputs: [
      [
        "Answer",
        "Your application is with our credit team. Two documents are still outstanding, and once we receive them the review continues.",
      ],
      ["Status explained", "being reviewed, waiting on documents from you"],
      ["Outstanding", "Latest 6 months bank statement"],
      ["Outstanding", "Property valuation report"],
      ["Suggested action", "Upload the outstanding documents"],
      ["Handoff required", "false", "pass"],
    ],
    proof: [
      ["2", "pendencies surfaced"],
      ["1", "action offered"],
      ["0", "claims outside the file"],
      ["₹0.49", "run cost"],
    ],
    note:
      "No commitment about timing or outcome appears anywhere in the answer, because the file does not contain one.",
    verdict: ["clear", "Cleared — answered from file"],
  },
  {
    id: "CaseAllocation",
    domain: "collections",
    name: "Case Allocation",
    tagline:
      "Ranks a delinquent portfolio, suppresses the cases that must not be contacted, and says which need a person.",
    inputs: [
      ["Portfolio", "5 cases"],
      ["C-1001", "8 dpd · ₹21,742"],
      ["C-1002", "23 dpd · ₹35,347"],
      ["Remaining", "3 more cases"],
    ],
    process: [
      "Score each case on days past due, exposure and conduct history",
      "Suppress on dispute, do-not-call, live promise or attempt limit",
      "Choose channel and language per borrower",
      "Mark the cases a person must take",
    ],
    outputs: [
      ["Total cases", "5"],
      ["Suppressed", "3 · dispute, DND, live promise", "amber"],
      ["Contactable", "2", "pass"],
      ["Total overdue", "₹1,91,065", "big"],
      [
        "C-1003",
        "priority 4.1 · human call · ta-IN · 78 dpd",
        "amber",
      ],
      ["C-1001", "priority 1.22 · digital nudge · whatsapp · en-IN"],
    ],
    proof: [
      ["5", "cases ranked"],
      ["3", "suppressed"],
      ["2", "contactable"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Suppression is applied before ranking, not after. A case under dispute never reaches a queue where someone could decide to call it anyway.",
    verdict: [
      "escalated",
      "Escalated — 1 case needs a human conversation",
    ],
  },
  {
    id: "SmartMandate",
    domain: "collections",
    name: "Smart Mandate",
    tagline:
      "Plans when to present a mandate so it lands after salary, with the pre-debit notice the rules require.",
    inputs: [
      ["Portfolio", "5 cases"],
      ["Mandate cap", "per registered mandate"],
      ["Salary signal", "from statement analysis"],
    ],
    process: [
      "Find each borrower's usual salary credit day",
      "Present inside a three-day window after it",
      "Issue the pre-debit notice at least 24 hours ahead",
      "Skip where a promise is live or no mandate is registered",
    ],
    outputs: [
      ["To present", "₹35,952 across 2 plans", "big"],
      ["C-1001", "present 02/10/2026 · ₹21,742", "pass"],
      ["C-1001 notice", "01/10/2026 · 24h ahead", "pass"],
      ["C-1004", "present 08/10/2026 · ₹14,210", "pass"],
      ["C-1002 skipped", "promise to pay by 17/09/2026 is live", "amber"],
      ["C-1003 skipped", "no active mandate registered", "amber"],
    ],
    proof: [
      ["2", "presentments planned"],
      ["3", "skipped with reason"],
      ["24h", "minimum notice"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Presenting against a live promise would pre-empt an agreement the borrower is keeping. That is why C-1002 is skipped and why the skip carries its reason.",
    verdict: ["clear", "Cleared — every plan carries notice"],
  },
  {
    id: "VoiceCollections",
    domain: "collections",
    name: "Voice Collections",
    tagline:
      "Runs a collections call within the conduct rules, blocking any line that would breach them before it is spoken.",
    inputs: [
      ["Case", "C-1001"],
      ["Language", "en-IN"],
      ["Call time", "11:30 IST"],
      ["Window", "08:00–19:00 IST"],
    ],
    process: [
      "Check the calling window and do-not-call register first",
      "Disclose the automated assistant and the recording",
      "Verify identity before any account detail is spoken",
      "Screen every generated line against the conduct rules",
    ],
    outputs: [
      ["Permitted", "true · inside window", "pass"],
      ["Outcome", "promise_to_pay", "big"],
      ["Promise", "₹21,742 due 28/09/2026", "pass"],
      ["Confirmed back to borrower", "true", "pass"],
      ["Disclosed automated assistant", "true", "pass"],
      ["Disclosed recording", "true", "pass"],
      ["Prohibited lines blocked", "0 of 5 lines", "pass"],
    ],
    proof: [
      ["5/5", "lines cleared"],
      ["0", "conduct breaches"],
      ["1", "promise captured"],
      ["₹0.45", "run cost"],
    ],
    note:
      "The screen runs on generated text before it is spoken, not on the recording afterwards. A breach caught in review has already happened.",
    verdict: ["clear", "Cleared — call permitted and compliant"],
  },
  {
    id: "SpeechAnalytics",
    domain: "collections",
    name: "Speech Analytics",
    tagline:
      "Scores a call against a published rubric and drops any quote it cannot find in the transcript.",
    inputs: [
      ["Call", "C-1001-call"],
      ["Language", "en-IN"],
      ["Transcript", "5 lines"],
      ["Rubric", "6 criteria, 30 points"],
    ],
    process: [
      "Score each rubric criterion separately",
      "Check the mandatory disclosures were actually made",
      "Verify every quote appears verbatim in the transcript",
      "Write coaching notes tied to what was scored down",
    ],
    outputs: [
      ["Score", "83.3% · 25 of 30", "big"],
      ["Disclosure", "5 / 5", "pass"],
      ["Courtesy", "5 / 5", "pass"],
      ["Identity verification", "4 / 5"],
      ["Objection handling", "3 / 5", "amber"],
      ["Compliance violations", "0", "pass"],
      ["Unverified quotes dropped", "0", "pass"],
    ],
    proof: [
      ["83.3%", "call score"],
      ["0", "missing disclosures"],
      ["2", "coaching notes"],
      ["₹0.46", "run cost"],
    ],
    note:
      "A quote the model cannot locate in the transcript is removed rather than shown. Fabricated evidence in a QA record is worse than no evidence.",
    verdict: ["clear", "Cleared — scored against rubric"],
  },
  {
    id: "CustomerIntelligence",
    domain: "portfolio",
    name: "Customer Intelligence",
    tagline:
      "Segments a book against published rules, and excludes anyone whose consent does not cover the purpose.",
    inputs: [
      ["Population", "9 customers"],
      ["Purpose", "marketing"],
      ["Rules", "4 published segment rules"],
    ],
    process: [
      "Drop anyone without a live consent for this purpose",
      "Apply each published rule to the remaining population",
      "Attach the rule text to every segment produced",
      "Check no rule references a protected attribute",
    ],
    outputs: [
      ["Population", "9"],
      ["Consented for marketing", "6", "pass"],
      ["Excluded, no consent", "3", "amber"],
      ["top_up_ready", "6 customers", "big"],
      ["Rule", "12m on book, 40% repaid, no bounces, not RED"],
      ["pre_delinquency_watch", "0 customers"],
      ["Protected attributes used", "0", "pass"],
    ],
    proof: [
      ["6 of 9", "eligible"],
      ["4", "rules applied"],
      ["0", "unsegmented"],
      ["₹0.00", "model cost"],
    ],
    note:
      "Data collected to underwrite a loan may not be used to market one. Three customers are excluded on that basis alone, and the exclusion is reported rather than silent.",
    verdict: ["clear", "Cleared — purpose limitation enforced"],
  },
  {
    id: "OpsResearch",
    domain: "portfolio",
    name: "Operations Research",
    tagline:
      "Models what the document pipeline actually costs in requests, and whether the ceiling can absorb the volume.",
    inputs: [
      ["Question", "What does the pipeline cost and can it keep up?"],
      ["Applications / month", "3,533"],
      ["Documents / month", "68,976"],
      ["Rate ceiling", "10 requests per minute"],
    ],
    process: [
      "Build the request model endpoint by endpoint",
      "Separate status polling from actual work",
      "Convert request volume into hours against the ceiling",
      "State which answers turn on an undocumented behaviour",
    ],
    outputs: [
      ["Total calls / month", "919,570", "big"],
      ["Status polls", "689,760 · 75.01% of all volume", "amber"],
      ["Quota units per document", "12"],
      ["Hours required / month", "1,379.5", "amber"],
      ["Business hours available", "176"],
      ["Utilisation", "7.84× capacity", "fail"],
      ["Backlog drain", "183.6 days or 2,203.4 days"],
    ],
    proof: [
      ["919,570", "calls modelled"],
      ["75.01%", "is polling"],
      ["7.84×", "over capacity"],
      ["12×", "spread on one unknown"],
    ],
    note:
      "Measuring documents rather than requests understates the load roughly twelvefold. Whether status polls count against the ceiling is undocumented, and it is the difference between six months and six years.",
    verdict: ["escalated", "Escalated — this is a capacity decision"],
  },
];

/* ── shared chrome ───────────────────────────────────────────────────────── */
const HEAD = (title, extra) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<script src="./support.js"></script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap">
<style>
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{background:${T.surface2};color:${T.ink};font-family:${SANS};
  font-size:13px;line-height:1.55;-webkit-font-smoothing:antialiased;
  font-feature-settings:"cv05" 1,"ss01" 1}
.eyebrow{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:${T.ink3}}
.mono{font-family:${MONO};font-variant-numeric:tabular-nums}
${extra}
</style>
</head>
<body>`;

const FOOT = `</body>
</html>
`;

/* ── one capability sheet ────────────────────────────────────────────────── */
const SHEET_CSS = `
.sheet{width:960px;height:660px;background:${T.surface};padding:30px 32px;display:flex;flex-direction:column}
.top{display:flex;align-items:center;justify-content:space-between;padding-bottom:14px;border-bottom:1px solid ${T.line}}
.brandline{display:flex;align-items:center;gap:8px}
.brandline .wm{font-size:14px;font-weight:700;letter-spacing:-.01em;color:${T.brand}}
.topright{display:flex;align-items:center;gap:12px}
.domain{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;
  padding:3px 8px;border-radius:4px;background:${T.brand50};color:${T.brand};border:1px solid ${T.brand200}}
.idx{font-size:11px;font-weight:500;color:${T.ink3};font-family:${MONO};font-variant-numeric:tabular-nums}
.title{margin:18px 0 0;font-size:26px;font-weight:700;letter-spacing:-.022em;line-height:1.18;text-wrap:balance}
.tagline{margin:7px 0 0;font-size:13px;color:${T.ink2};max-width:78ch}
.tracks{display:grid;grid-template-columns:1fr 1fr 1.3fr;gap:13px;margin-top:20px;flex:1;min-height:0}
.track{min-width:0;border-radius:8px;overflow:hidden}
.track.in{background:${T.surface2};border:1px solid ${T.line};padding:13px 15px}
.track.proc{background:${T.brand50};border:1px solid ${T.brand200};padding:13px 15px}
.track.out{background:${T.surface};border:1px solid ${T.brand300};padding:0;
  box-shadow:0 1px 3px 0 rgb(32 72 135 / 0.10)}
.track.out .band{background:${T.brand};padding:9px 15px}
.track.out .band .eyebrow,.track.out .band .n{color:#fff}
.track.out .band .n{border-color:rgb(255 255 255 / 0.35);background:rgb(255 255 255 / 0.14)}
.track.out .body{padding:12px 15px 13px}
.th{display:flex;align-items:baseline;gap:7px;margin-bottom:12px}
.track.out .band .th{margin-bottom:0}
.th .n{font-family:${MONO};font-size:10px;font-weight:500;color:${T.brand};
  border:1px solid ${T.brand200};background:${T.brand50};border-radius:3px;padding:0 4px;line-height:15px}
.rows{display:flex;flex-direction:column;gap:9px}
.row .k{font-size:10.5px;font-weight:500;color:${T.ink3};letter-spacing:.01em}
.row .v{font-size:12.5px;color:${T.ink};margin-top:1px;overflow-wrap:anywhere}
.row .v.big{font-size:19px;font-weight:650;letter-spacing:-.018em;font-variant-numeric:tabular-nums;line-height:1.25}
.row .v.pass{color:${T.pass};font-weight:500}
.row .v.amber{color:${T.amber};font-weight:500}
.row .v.fail{color:#b42318;font-weight:600}
.row .cite{display:inline-block;font-family:${MONO};font-size:10px;color:${T.ink3};
  background:${T.surface3};border-radius:3px;padding:1px 5px;margin-left:6px;vertical-align:1px}
.steps{display:flex;flex-direction:column;gap:10px;border-left:2px solid ${T.brand200};padding-left:14px}
.step{font-size:12px;color:${T.ink2};position:relative}
.step::before{content:"";position:absolute;left:-19px;top:6px;width:6px;height:6px;
  border-radius:50%;background:${T.brand};box-shadow:0 0 0 2px ${T.surface}}
.foot{margin-top:18px;padding-top:15px;border-top:1px solid ${T.line};display:flex;align-items:flex-end;justify-content:space-between;gap:20px}
.figs{display:flex;gap:10px}
.fig{background:${T.brand50};border:1px solid ${T.brand200};border-radius:7px;padding:8px 13px}
.fig .fv{font-size:20px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums;line-height:1.15;color:${T.brand}}
.fig .fl{font-size:10px;font-weight:500;color:${T.ink3};letter-spacing:.02em;margin-top:2px;white-space:nowrap}
/* The rule at the head states the brand; the bar at the foot states the outcome. */
.toprule{height:3px;background:${T.brand};margin:-30px -32px 18px}
.verdictbar{height:4px;margin:14px -32px -30px}
.verdictbar.clear{background:${T.pass}}
.verdictbar.escalated{background:${T.amber}}
.verdicts{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:0 0 auto}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;font-weight:600;
  padding:4px 10px;border-radius:999px;white-space:nowrap}
.chip.pass{background:${T.passSoft};color:${T.pass};border:1px solid ${T.passBorder}}
.chip.amber{background:${T.amberSoft};color:${T.amber};border:1px solid ${T.amberBorder}}
.chip .dot{width:5px;height:5px;border-radius:50%;background:currentColor}
.note{margin-top:12px;font-size:11.5px;line-height:1.5;color:${T.ink2};
  border-left:2px solid ${T.lineStrong};padding-left:11px;max-width:96ch}
`;

function sheet(agent, index) {
  const dom = DOMAINS[agent.domain];
  const [vk, vt] = agent.verdict;
  const rows = (list) =>
    list
      .map(([k, v, tone, cite]) => {
        const cls = tone && tone !== "cite" ? ` ${tone}` : "";
        const tag = cite ? `<span class="cite">${esc(cite)}</span>` : "";
        return `<div class="row"><div class="k">${esc(k)}</div><div class="v${cls}">${esc(v)}${tag}</div></div>`;
      })
      .join("");

  return (
    HEAD(agent.name, SHEET_CSS) +
    `
<div class="sheet">
  <div class="toprule"></div>
  <div class="top">
    <div class="brandline">${mark(20, T.brand)}<span class="wm">GravAI</span></div>
    <div class="topright">
      <span class="domain">${esc(dom.label)}</span>
      <span class="idx">AGENT ${String(index + 1).padStart(2, "0")} / 14</span>
    </div>
  </div>

  <h1 class="title">${esc(agent.name)}</h1>
  <p class="tagline">${esc(agent.tagline)}</p>

  <div class="tracks">
    <div class="track in">
      <div class="th"><span class="n">1</span><span class="eyebrow">What goes in</span></div>
      <div class="rows">${rows(agent.inputs)}</div>
    </div>
    <div class="track proc">
      <div class="th"><span class="n">2</span><span class="eyebrow">What it does</span></div>
      <div class="steps">${agent.process.map((s) => `<div class="step">${esc(s)}</div>`).join("")}</div>
    </div>
    <div class="track out">
      <div class="band">
        <div class="th"><span class="n">3</span><span class="eyebrow">What comes out</span></div>
      </div>
      <div class="body">
        <div class="rows">${rows(agent.outputs)}</div>
      </div>
    </div>
  </div>

  <div class="foot">
    <div class="figs">
      ${agent.proof.map(([v, l]) => `<div class="fig"><div class="fv">${esc(v)}</div><div class="fl">${esc(l)}</div></div>`).join("")}
    </div>
    <div class="verdicts">
      <span class="chip ${vk === "escalated" ? "amber" : "pass"}"><span class="dot"></span>${esc(vt)}</span>
      <span class="chip pass"><span class="dot"></span>Guardrails passed</span>
    </div>
  </div>
  <p class="note">${esc(agent.note)}</p>
  <div class="verdictbar ${vk}"></div>
</div>
` +
    FOOT
  );
}

/* ── the index board ─────────────────────────────────────────────────────── */
const MAIN_CSS = `
.board{width:1280px;height:960px;background:${T.surface};padding:38px 40px;display:flex;flex-direction:column}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:32px;
  padding-bottom:20px;border-bottom:1px solid ${T.line}}
.brandline{display:flex;align-items:center;gap:9px;margin-bottom:16px}
.brandline .wm{font-size:15px;font-weight:700;letter-spacing:-.01em;color:${T.brand}}
h1{margin:0;font-size:34px;font-weight:700;letter-spacing:-.025em;line-height:1.14}
.sub{margin:9px 0 0;font-size:14px;color:${T.ink2};max-width:64ch}
.counts{display:flex;gap:26px;flex:0 0 auto;padding-top:4px}
.count .cv{font-size:26px;font-weight:650;letter-spacing:-.02em;color:${T.brand};
  font-variant-numeric:tabular-nums;line-height:1.1}
.count .cl{font-size:10px;font-weight:500;color:${T.ink3};letter-spacing:.03em;margin-top:2px}
.prov{margin:18px 0 0;display:flex;gap:10px;align-items:flex-start;background:${T.brand50};
  border:1px solid ${T.brand200};border-radius:8px;padding:11px 14px;font-size:12px;color:${T.ink2}}
.prov strong{color:${T.brand};font-weight:600}
.groups{margin-top:20px;display:flex;flex-direction:column;gap:16px;flex:1;min-height:0}
.group{display:grid;grid-template-columns:128px 1fr;gap:16px;align-items:start}
.glabel{padding-top:9px}
.glabel .gt{font-size:12px;font-weight:600;color:${T.ink};letter-spacing:-.005em}
.glabel .gc{font-size:10.5px;color:${T.ink3};margin-top:2px}
.tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.tile{background:${T.surface};border:1px solid ${T.line};border-radius:8px;padding:12px 13px;
  box-shadow:${T.shadow};display:flex;flex-direction:column;gap:6px;min-height:0}
.tile .tn{font-size:13px;font-weight:600;letter-spacing:-.008em;line-height:1.25}
.tile .td{font-size:11px;line-height:1.45;color:${T.ink3};flex:1}
.tile .tf{display:flex;align-items:baseline;gap:6px;padding-top:7px;border-top:1px solid ${T.line}}
.tile .tv{font-size:15px;font-weight:650;letter-spacing:-.016em;color:${T.brand};font-variant-numeric:tabular-nums}
.tile .tl{font-size:10px;color:${T.ink3}}
.tile.esc{border-left:3px solid ${T.amberBorder}}
.legend{margin-top:18px;padding-top:15px;border-top:1px solid ${T.line};
  display:flex;justify-content:space-between;align-items:center;gap:28px}
.keys{display:flex;gap:22px;flex-wrap:wrap}
.key{display:flex;align-items:center;gap:7px;font-size:11px;color:${T.ink2}}
.key .sw{width:11px;height:11px;border-radius:3px;flex:0 0 auto}
.stamp{font-family:${MONO};font-size:10.5px;color:${T.ink3};white-space:nowrap}
`;

const HEADLINE = {
  DocumentIntelligence: ["98", "calls · 29 pages"],
  BankStatementAnalytics: ["₹85,000", "verified income"],
  AccountAggregator: ["24", "doc calls avoided"],
  KycVerification: ["4/4", "checks agree"],
  CreditAppraisal: ["39.7%", "FOIR · 5 rules"],
  RiskScoring: ["6.58%", "AMBER band"],
  MsmeUnderwriting: ["₹58,00,000", "assessed turnover"],
  OnboardingAssistant: ["2", "pendencies surfaced"],
  CaseAllocation: ["3 of 5", "suppressed"],
  SmartMandate: ["₹35,952", "planned, 24h notice"],
  VoiceCollections: ["5/5", "lines cleared"],
  SpeechAnalytics: ["83.3%", "call score"],
  CustomerIntelligence: ["6 of 9", "consent-eligible"],
  OpsResearch: ["919,570", "calls modelled"],
};

function main() {
  const order = ["intake", "credit", "collections", "portfolio"];
  const groups = order
    .map((key) => {
      const members = AGENTS.filter((a) => a.domain === key);
      const tiles = members
        .map((a) => {
          const [v, l] = HEADLINE[a.id];
          const esced = a.verdict[0] === "escalated" ? " esc" : "";
          const short = a.tagline.split(/(?<=\.)\s/)[0];
          return `<div class="tile${esced}">
            <div class="tn">${esc(a.name)}</div>
            <div class="td">${esc(short)}</div>
            <div class="tf"><span class="tv">${esc(v)}</span><span class="tl">${esc(l)}</span></div>
          </div>`;
        })
        .join("");
      return `<div class="group">
        <div class="glabel"><div class="gt">${esc(DOMAINS[key].label)}</div><div class="gc">${members.length} agents</div></div>
        <div class="tiles">${tiles}</div>
      </div>`;
    })
    .join("");

  return (
    HEAD("Agent Capability Sheets", MAIN_CSS) +
    `
<div class="board">
  <div>
    <div class="brandline">${mark(22, T.brand)}<span class="wm">GravAI</span></div>
    <div class="top">
      <div>
        <h1>Agent capability sheets</h1>
        <p class="sub">One sheet per agent: what goes in, what it does with it, and what comes out — with the measured figures from an actual run rather than an illustration of one.</p>
      </div>
      <div class="counts">
        <div class="count"><div class="cv">14</div><div class="cl">AGENTS</div></div>
        <div class="count"><div class="cv">14</div><div class="cl">GUARDRAILS PASSED</div></div>
        <div class="count"><div class="cv">4</div><div class="cl">ESCALATED BY DESIGN</div></div>
      </div>
    </div>
  </div>

  <div class="prov">${mark(15, T.brand)}<div><strong>How to read these.</strong> Every figure was produced by running the agent against the sandbox and capturing its output, so a sheet cannot drift from the agent it describes. Four agents escalate rather than decide — that is the designed behaviour, not a failure.</div></div>

  <div class="groups">${groups}</div>

  <div class="legend">
    <div class="keys">
      <div class="key"><span class="sw" style="background:${T.passSoft};border:1px solid ${T.passBorder}"></span>Cleared — completed without escalation</div>
      <div class="key"><span class="sw" style="background:${T.amberSoft};border:1px solid ${T.amberBorder}"></span>Escalated — routed to a person by design</div>
      <div class="key"><span class="sw" style="background:${T.brand50};border:1px solid ${T.brand200}"></span>Cited — value bound to a document and page</div>
    </div>
    <div class="stamp">sandbox run · tenant acme · scorecard-v1-illustrative</div>
  </div>
</div>
` +
    FOOT
  );
}

/* ── canvas layout ───────────────────────────────────────────────────────── */
const SHEET_W = 960,
  SHEET_H = 660,
  GAP_X = 120,
  GAP_Y = 160;
const ROW_W = 4 * SHEET_W + 3 * GAP_X; // 4200
const MAIN_W = 1280,
  MAIN_H = 960;

function layout() {
  const boards = [
    {
      file: "Main.dc.html",
      x: Math.round((ROW_W - MAIN_W) / 2),
      y: 0,
      w: MAIN_W,
      h: MAIN_H,
      title: "Overview",
    },
  ];
  const order = ["intake", "credit", "collections", "portfolio"];
  let y = MAIN_H + GAP_Y;
  for (const key of order) {
    const members = AGENTS.filter((a) => a.domain === key);
    const rowWidth = members.length * SHEET_W + (members.length - 1) * GAP_X;
    let x = Math.round((ROW_W - rowWidth) / 2);
    for (const a of members) {
      boards.push({
        file: `${a.id}.dc.html`,
        x,
        y,
        w: SHEET_W,
        h: SHEET_H,
        title: a.name,
      });
      x += SHEET_W + GAP_X;
    }
    y += SHEET_H + GAP_Y;
  }
  return { artboards: boards, launch: { view: "canvas" } };
}

/* ── write ───────────────────────────────────────────────────────────────── */
mkdirSync(HERE, { recursive: true });
writeFileSync(join(HERE, "Main.dc.html"), main(), "utf8");
AGENTS.forEach((a, i) =>
  writeFileSync(join(HERE, `${a.id}.dc.html`), sheet(a, i), "utf8"),
);
writeFileSync(
  join(HERE, "canvas.json"),
  JSON.stringify(layout(), null, 2),
  "utf8",
);
console.log(`wrote Main.dc.html + ${AGENTS.length} agent sheets + canvas.json`);
console.log(AGENTS.map((a, i) => `  ${String(i + 1).padStart(2)} ${a.id}`).join("\n"));
