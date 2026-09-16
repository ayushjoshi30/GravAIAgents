/**
 * Real platform numbers, in one place, each with its source.
 *
 * Rule 4 of the build: no invented numbers — cite the source or return null
 * with a reason. Every figure quoted anywhere on this site comes from here,
 * and every figure here is traceable to GRAVAI_SPEC.md section 1.2 (production
 * facts from the owner's current pipeline) or to the platform source itself.
 *
 * If a number is not confirmed, it is marked `verified: false` and the site
 * says so where it appears rather than presenting it as fact.
 */

export interface PlatformFact {
  id: string;
  label: string;
  value: string;
  unit?: string;
  note: string;
  source: string;
  verified: boolean;
}

export const DOC_AI_RPM = 10;

/** Calls against the Document Intelligence quota for one document. */
export const CALL_MODEL = {
  /** submit + ~10 back-off polls + results */
  extract: { submit: 1, polls: 10, results: 1, llmReads: 0, total: 12 },
  /** Same back-off, plus one LLM read because digitise returns text. */
  digitiseBackedOff: { submit: 1, polls: 10, results: 1, llmReads: 1, total: 13 },
  /** The bug: flat 0.8 s polling, no back-off, on a ~30 s job. */
  digitiseFlat: { submit: 1, polls: 37, results: 1, llmReads: 1, total: 40 },
} as const;

export const VOLUME = {
  tenants: 18,
  applicationsPerMonth: 3533,
  documentsPerApplication: 25,
  pagesPerDocument: 3.0,
  llmCallsPerApplication: 24,
  largestTenantApplicationShare: 0.48,
  largestTenantDocumentShare: 0.62,
  get documentsPerMonth(): number {
    return Math.round(this.applicationsPerMonth * this.documentsPerApplication);
  },
} as const;

/** One fully instrumented production run, quoted exactly. */
export const REFERENCE_RUN = {
  loan: "18301",
  documents: 197,
  modelCalls: 113,
  inputTokens: 692_535,
  outputTokens: 43_866,
  audioSeconds: 154,
  costInr: 232.43,
} as const;

export const RISK_BANDS = [
  { band: "GREEN", rule: "below 6%", tone: "pass" as const },
  { band: "AMBER", rule: "6% to 15%", tone: "attention" as const },
  { band: "RED", rule: "above 15%", tone: "fail" as const },
];

/**
 * The rate card. Only two rows are confirmed by a tenant contract; the rest
 * are deliberately unset rather than guessed, because a guessed unit price
 * propagates into every cost figure on the platform.
 */
export interface RateCardRow {
  product: string;
  unit: string;
  inrPerUnit: number | null;
  source: string;
}

export const RATE_CARD: RateCardRow[] = [
  {
    product: "docai_extract",
    unit: "page",
    inrPerUnit: 1.0,
    source: "Tenant contract 2026-08-19",
  },
  {
    product: "docai_digitise",
    unit: "page",
    inrPerUnit: 0.5,
    source: "Tenant contract 2026-08-19 (public price page listed ₹0.50 only)",
  },
  { product: "llm_input", unit: "1K tokens", inrPerUnit: null, source: "Not set — per contract" },
  { product: "llm_output", unit: "1K tokens", inrPerUnit: null, source: "Not set — per contract" },
  { product: "stt", unit: "audio second", inrPerUnit: null, source: "Not set — per contract" },
  { product: "tts", unit: "1K characters", inrPerUnit: null, source: "Not set — per contract" },
  { product: "translate", unit: "1K characters", inrPerUnit: null, source: "Not set — per contract" },
];

export const PROOF_POINTS: PlatformFact[] = [
  {
    id: "calls-per-document",
    label: "API calls per document",
    value: "12 vs 40",
    note: "Extract with back-off is 1 submit, ~10 polls, 1 results fetch. Digitise polling flat at 0.8 s with no back-off was 37 polls plus an LLM read: 40. Applying the same back-off to both paths brings digitise to 13.",
    source: "GRAVAI_SPEC.md §1.2, DECISIONS.md D-006",
    verified: true,
  },
  {
    id: "governor",
    label: "Document Intelligence ceiling",
    value: "10",
    unit: "req/min",
    note: "Uniform across Starter, Pro and Business. Extract and digitise draw on the same bucket. It is not a limit you can buy your way out of, and adding workers does not move it.",
    source: "GRAVAI_SPEC.md §1.2, the platform's rate governor",
    verified: true,
  },
  {
    id: "agents",
    label: "Agents in the catalog",
    value: "13",
    note: "Three P0 credit-core agents, seven P1 risk, collections and voice agents, three P2 intelligence and operations agents. One catalog, read by REST, MCP and this site.",
    source: "packages/gravai_agents/catalog.py",
    verified: true,
  },
  {
    id: "audit",
    label: "Audit log",
    value: "Hash-chained",
    note: "Append-only, chained per tenant, with a verification endpoint that recomputes from the genesis hash and names the first sequence number that does not follow.",
    source: "DECISIONS.md D-008, D-010",
    verified: true,
  },
];

export const OPEN_QUESTIONS: { id: string; question: string; why: string }[] = [
  {
    id: "D-005",
    question: "Do Document Intelligence status polls count against the 10/min limit?",
    why: "GravAI assumes they do, which is the conservative reading. If they do not, throughput rises by roughly 6x on the quota model and nothing breaks. The opposite assumption would silently overrun the limit. This is the single highest-value question to put to the provider.",
  },
  {
    id: "D-006",
    question: "Does the digitise status endpoint tolerate back-off?",
    why: "Extract already backs off. Applying the same schedule to digitise is what turns 40 calls per document into 13.",
  },
  {
    id: "D-004",
    question: "Are the Document Intelligence job paths correct?",
    why: "The extract and digitise paths come from observed production traffic, not from confirmed public documentation. They are environment variables, so a correction needs no code change.",
  },
  {
    id: "D-007",
    question: "What is the exact model id of the reasoning model?",
    why: "The production pipeline uses a model referred to as 105B. No model id is hardcoded anywhere in GravAI; it is read from configuration.",
  },
];

export const COMPLIANCE_CONTROLS = [
  {
    id: "rbi-dl",
    regime: "RBI Digital Lending Directions",
    controls: [
      "Key Fact Statement available to the onboarding agent and surfaced on request",
      "Data minimisation: no contacts, no media access, no device scraping",
      "Consent captured per purpose, not once at sign-up",
      "Grievance officer details surfaced from tenant configuration",
      "No automated adverse action — every credit decision is escalated to a human by design",
      "Cooling-off information provided in the borrower's language",
    ],
  },
  {
    id: "dpdp",
    regime: "DPDP Act 2023 and Rules",
    controls: [
      "Consent notices with stated purpose and expiry, held in a consent registry",
      "Purpose limitation enforced at the feature level in the segmentation agent",
      "Data-principal request tooling: access, erasure and correction with a workflow and an audit trail",
      "Retention classes per table driving scheduled purge jobs",
      "Breach notification runbook with a timeline",
      "Cross-border restriction: India regions only (Azure Central India / South India)",
    ],
  },
  {
    id: "aa",
    regime: "Account Aggregator (RBI NBFC-AA, ReBIT, Sahamati)",
    controls: [
      "Consent artefacts stored with purpose, frequency and expiry in ReBIT shapes",
      "Data used only for the stated purpose; deleted on expiry",
      "Live rails only through a licensed AA or TSP — GravAI ships the interface and a sandbox adapter, and says so",
    ],
  },
  {
    id: "uidai",
    regime: "UIDAI / Aadhaar",
    controls: [
      "Aadhaar masked to the last four digits at the point of extraction",
      "Full Aadhaar never stored, never logged, never emitted by any agent",
      "DigiLocker and offline e-KYC flows only",
      "Red-team suite asserts zero full-Aadhaar emissions",
    ],
  },
  {
    id: "collections",
    regime: "Collections conduct",
    controls: [
      "Calling window 08:00 to 19:00 IST by default, per tenant configuration",
      "DND and UCC registry checked before every outbound call",
      "AI disclosure and recording notice at the start of every call",
      "No third-party disclosure of the debt",
      "Harassment-language classifier blocks output before it reaches synthesis",
      "Complaint capture routed to a human",
    ],
  },
  {
    id: "payments",
    regime: "Payments (NPCI e-NACH / UPI AutoPay)",
    controls: [
      "Pre-debit notification at least 24 hours ahead",
      "Retry limits per tenant policy",
      "Presentment amount never exceeds the registered mandate cap",
    ],
  },
  {
    id: "it-governance",
    regime: "IT governance and model risk",
    controls: [
      "Audit-log retention of at least 8 years, immutable, configurable",
      "Change management through CI gates",
      "Prompt and model versioning with eval gates before promotion",
      "Drift monitoring and periodic human-review sampling",
      "Adverse-decision explainability with citations",
    ],
  },
];

export const JOURNEY = [
  {
    id: "onboarding",
    step: "Digital onboarding",
    graviton: "Application capture and document upload.",
    agents: ["onboarding_assistant", "doc_intelligence"],
    detail:
      "The onboarding agent explains what each document is for in the applicant's language. Document Intelligence classifies every file as it arrives and routes it to extract or digitise.",
  },
  {
    id: "kyc",
    step: "DigiLocker KYC",
    graviton: "Verified issued documents flow into the application.",
    agents: ["kyc_verification"],
    detail:
      "Identity is cross-checked across DigiLocker, CKYC and the uploaded set. Names are matched with token-sort plus phonetic logic that handles Indian name orderings. Aadhaar never leaves the masked form.",
  },
  {
    id: "credit",
    step: "Credit",
    graviton: "Bureau pull, financial parameters, FOIR and LTV indicators.",
    agents: ["bank_statement_analytics", "aa_data", "msme_underwriting"],
    detail:
      "Six to twelve months of statements become a reconciled income build-up, an obligations list and a bounce history — or the same months arrive already structured through the Account Aggregator, under a consent artefact and with no extraction at all. For thin-file MSME borrowers, GST, ITR, bank credits and invoices are reconciled against each other.",
  },
  {
    id: "bre",
    step: "BRE evaluation",
    graviton: "No-code rule flows and decision tables; every pass and fail visible.",
    agents: ["credit_appraisal"],
    detail:
      "The Credit Appraisal agent calls the BRE, then explains every rule outcome in plain language fit for an adverse-action note. It does not re-implement the rules.",
  },
  {
    id: "underwriting",
    step: "Underwriter single view",
    graviton: "One screen with the full application context.",
    agents: ["credit_appraisal", "risk_scoring"],
    detail:
      "The CAM arrives with eligibility arithmetic shown alongside its inputs, and a risk band from a versioned scorecard — never from the language model.",
  },
  {
    id: "deviations",
    step: "Deviations",
    graviton: "Raised with parameters, documents and justification; routed by approval matrix.",
    agents: ["credit_appraisal"],
    detail:
      "Each deviation carries its parameter, the policy value, the actual value and a severity from L1 to L3, which determines who has to approve it.",
  },
  {
    id: "tasks",
    step: "Task Center",
    graviton: "Pendencies and requirements routed to the right stakeholder.",
    agents: ["onboarding_assistant"],
    detail:
      "Pendencies are chased in the applicant's language. Every chase is an audited event, not an untracked phone call.",
  },
  {
    id: "lan",
    step: "LAN creation and collections",
    graviton: "Loan account number, then servicing and recovery.",
    agents: [
      "case_allocation",
      "smart_mandate",
      "voice_collections",
      "speech_analytics",
      "customer_data_intelligence",
    ],
    detail:
      "After disbursal the portfolio agents take over: cases ranked and routed, mandates scheduled against detected salary dates, calls placed inside the permitted window, and every call scored for conduct afterwards.",
  },
];

export const LANGUAGES = [
  { code: "en-IN", name: "English" },
  { code: "hi-IN", name: "Hindi" },
  { code: "bn-IN", name: "Bengali" },
  { code: "gu-IN", name: "Gujarati" },
  { code: "kn-IN", name: "Kannada" },
  { code: "ml-IN", name: "Malayalam" },
  { code: "mr-IN", name: "Marathi" },
  { code: "od-IN", name: "Odia" },
  { code: "pa-IN", name: "Punjabi" },
  { code: "ta-IN", name: "Tamil" },
  { code: "te-IN", name: "Telugu" },
];


/**
 * Display labels for billable products.
 *
 * The ledger stores provider-neutral product keys; these are what an operator
 * reads. Naming a capability rather than a vendor is deliberate: the rate card,
 * the governor and the agents are all written against the capability, and a
 * provider change should not rewrite a single screen.
 */
export const PRODUCT_LABELS: Record<string, string> = {
  docai_extract: "Document extraction",
  docai_digitise: "Document digitisation",
  llm_input: "Model input tokens",
  llm_output: "Model output tokens",
  stt: "Speech to text",
  tts: "Text to speech",
  translate: "Translation",
};

export function productLabel(key: string): string {
  return PRODUCT_LABELS[key] ?? key.replace(/_/g, " ");
}

/** Coarse grouping used by the usage charts. */
export const PRODUCT_GROUPS = [
  { key: "documents", label: "Document intelligence", matches: (p: string) => p.startsWith("docai") },
  { key: "model", label: "Model", matches: (p: string) => p.startsWith("llm") || p === "translate" },
  { key: "speech", label: "Speech", matches: (p: string) => p === "stt" || p === "tts" },
];

/**
 * The AI capabilities the platform consumes, described by what they do rather
 * than by who supplies them. The adapter layer means an agent codes against
 * the capability; the provider is configuration.
 */
export const AI_CAPABILITIES = [
  {
    id: "model",
    name: "Language model",
    use: "Every reasoning step: narration classification, memorandum drafting, rule explanation, intent and slot extraction, report writing.",
    note: "Temperature 0.0 to 0.2 — extraction and decisioning are not creative tasks. JSON mode where the model supports it, with a bounded repair loop where it does not. Model identifiers are configuration; none is hardcoded.",
  },
  {
    id: "documents",
    name: "Document intelligence",
    use: "Reading roughly 88,000 documents a month. Extraction returns structured fields; digitisation returns text and needs one more model call to read it.",
    note: "Asynchronous: one document is one submit, N status polls and one results fetch. Capped at 10 requests per minute across both paths, which is the platform's binding constraint.",
  },
  {
    id: "stt",
    name: "Speech to text",
    use: "Transcribing collections calls for the voice agent's turn loop, and again afterwards for the quality and compliance score.",
    note: "Language code or automatic detection; audio over 30 seconds is chunked at natural boundaries. Diarised where the analytics agent needs to attribute a quote.",
  },
  {
    id: "tts",
    name: "Text to speech",
    use: "The borrower-facing half of every voice call, in the language the borrower chose.",
    note: "Text chunked to 1,000 characters at sentence boundaries so prosody survives the chunking.",
  },
  {
    id: "translate",
    name: "Translation and transliteration",
    use: "Extending English and Hindi coverage to the other nine supported languages without maintaining nine prompt sets.",
    note: "Formal and colloquial registers; chunked at 1,500 characters. Transliteration for names and addresses that must round-trip.",
  },
  {
    id: "lid",
    name: "Language identification",
    use: "Choosing the borrower's language from their first message rather than asking them to pick from a list.",
    note: "Runs before the first substantive reply in chat.",
  },
];
