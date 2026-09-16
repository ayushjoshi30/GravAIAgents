/**
 * The GravAI agent catalog.
 *
 * The first nine fields of every entry are a faithful transcription of
 * `packages/gravai_agents/src/gravai_agents/catalog.py`, which the REST API,
 * the MCP tool list and this site all read. Nothing here is invented: if an
 * agent is not in that file it is not on this site.
 *
 * `detail` carries the page content for /agents/[id] and is transcribed from
 * GRAVAI_SPEC.md section 4 (purpose, inputs, output schema, tools, rules,
 * escalation triggers, eval gates).
 *
 * When the console is connected to a live API, /v1/agents is the source of
 * truth and this file is the fallback used for static rendering and for the
 * marketing pages, which are never authenticated.
 */

export type AgentTier = "P0" | "P1" | "P2";

export type Scope =
  | "applications:read"
  | "applications:write"
  | "documents:read"
  | "documents:write"
  | "agents:run"
  | "decisions:approve"
  | "collections:read"
  | "collections:write"
  | "audit:read"
  | "usage:read"
  | "admin";

export interface AgentDetail {
  /** One paragraph: what this agent is for. */
  purpose: string;
  inputs: string[];
  /** Named top-level keys of the agent's output contract. */
  outputKeys: string[];
  /** MCP / internal tools the agent is allowed to call. */
  tools: string[];
  /** Guardrails written into the prompt and enforced by validators. */
  rules: string[];
  escalateWhen: string[];
  /** Gates a prompt version must pass before it can be promoted. */
  evals: string[];
  /** AI capabilities this agent consumes, named by what they do. */
  aiServices: string[];
}

export interface Agent {
  id: string;
  name: string;
  tier: AgentTier;
  summary: string;
  /** The MCP agents-as-tool name that invokes this agent. */
  toolName: string;
  scopes: Scope[];
  /** Advisory agents never take an irreversible action on their own. */
  advisoryOnly: boolean;
  /** Ignosis capability this achieves parity with, where one exists. */
  parityWith: string | null;
  tags: string[];
  detail: AgentDetail;
}

export const AGENTS: Agent[] = [
  // --- P0: the credit core -------------------------------------------------
  {
    id: "doc_intelligence",
    name: "Document Intelligence Agent",
    tier: "P0",
    summary:
      "Classifies every uploaded document, routes it to extract or digitise, and returns structured fields with a citation for each value.",
    toolName: "classify_documents",
    scopes: ["agents:run", "documents:read", "documents:write"],
    advisoryOnly: true,
    parityWith: "Document intelligence substrate under Bank Statement Analytics",
    tags: ["documents", "extraction"],
    detail: {
      purpose:
        "Classify every uploaded document against the Indian lending taxonomy, route each one to extract or digitise, produce structured fields with a page-level citation for every value, and quality-check the file itself. This is the agent whose routing decision determines the platform's Document Intelligence bill and its throughput ceiling.",
      inputs: [
        "application_id",
        "A list of DocumentRef (blob URI, mime type, page count)",
      ],
      outputKeys: [
        "documents[].type",
        "documents[].confidence",
        "documents[].route",
        "documents[].fields{value, citation, confidence, reason}",
        "documents[].quality{legible, complete, issues}",
        "documents[].flags[]",
        "escalate",
        "reasoning_summary",
      ],
      tools: [
        "docai.extract",
        "docai.digitise",
        "docai.job_status",
        "graviton.list_documents",
      ],
      rules: [
        "Never merge fields across documents.",
        "KYC past its validity date is flagged as expired, never silently accepted.",
        "Blurred or partial pages are reported in quality.issues rather than guessed at.",
        "Every extracted value carries a document id and page number or it is returned as null with a reason.",
      ],
      escalateWhen: [
        "Unknown document type exceeds 10% of the batch",
        "Any tamper flag is raised",
        "Confidence below 0.7 on a required KYC or income document",
      ],
      evals: [
        "Classification F1 at or above 0.95 on a 300-document golden set",
        "Field exact-match at or above 0.92",
        "Citation validity 100%",
      ],
      aiServices: ["Document intelligence (extraction and digitisation)",
        "Language model (fast tier, classification)"],
    },
  },
  {
    id: "bank_statement_analytics",
    name: "Bank Statement Analytics Agent",
    tier: "P0",
    summary:
      "Turns 6-12 months of statements into income, obligations, bounces and balance behaviour, reconciled month by month.",
    toolName: "analyse_bank_statement",
    scopes: ["agents:run", "documents:read"],
    advisoryOnly: true,
    parityWith: "Bank Statement Analytics",
    tags: ["credit", "income"],
    detail: {
      purpose:
        "Turn six to twelve months of bank statements into the inputs an underwriter actually needs: median net monthly income, identified EMI obligations, bounce history, cash behaviour and average balances — with a month-by-month reconciliation that must balance before any figure is published.",
      inputs: [
        "Extracted transaction tables per statement",
        "Declared income and employer",
        "Application product",
      ],
      outputKeys: [
        "accounts[]{bank, period, opening_balance, closing_balance, avg_monthly_balance}",
        "income{salary_credits[], monthly_net_income_median, income_stability_score}",
        "obligations{emis[], total_monthly_emi}",
        "bounces[]",
        "cash_pattern{cash_deposit_ratio, round_amount_credits}",
        "flags[]",
        "escalate",
      ],
      tools: ["None beyond stored extractions — reasoning plus deterministic code"],
      rules: [
        "Salary detection requires at least three consistent monthly credits with employer, SAL or NEFT narration evidence.",
        "EMIs are identified from lender-pattern narrations (ECS, NACH, ACH, lender names) on a monthly cadence.",
        "Any month where opening + credits - debits does not equal closing within ₹1 raises flags: reconciliation_failed.",
        "A credit from the applicant's own account is never classified as salary.",
        "The reconciliation is arithmetic, done in code. The model classifies narrations only.",
      ],
      escalateWhen: [
        "Reconciliation fails on any month",
        "More than two bounces in six months",
        "Income median below declared income by more than 20%",
      ],
      evals: [
        "Narration classification accuracy at or above 0.93",
        "Income median within 5% of the labelled value on the golden set",
      ],
      aiServices: ["Language model (narration classification)"],
    },
  },
  {
    id: "credit_appraisal",
    name: "Credit Appraisal Agent",
    tier: "P0",
    summary:
      "Produces the Credit Appraisal Memorandum: eligibility with FOIR and LTV, income build-up, cross-checks, deviation matrix, and a plain-language explanation of every BRE pass and fail.",
    toolName: "underwrite_application",
    scopes: ["agents:run", "applications:read", "documents:read"],
    advisoryOnly: true,
    parityWith: "Underwriting decisioning",
    tags: ["credit", "decisioning"],
    detail: {
      purpose:
        "Produce the Credit Appraisal Memorandum and explain the Business Rules Engine result in plain language. FOIR and LTV are computed in code and shown with their inputs; the agent explains them, it does not produce them. The recommendation is always advisory — an underwriter approves in the console.",
      inputs: [
        "Outputs of the Document Intelligence and Bank Statement Analytics agents",
        "Bureau summary from Graviton",
        "Product policy pack (pinned version)",
        "Collateral valuation, where the product has one",
      ],
      outputKeys: [
        "eligibility{net_monthly_income, existing_emi, proposed_emi, foir, ltv, formula_inputs, citations}",
        "income_build_up[]",
        "cross_checks[]",
        "bre{outcome, rules[]{rule_id, result, plain_language}}",
        "deviations[]{parameter, policy, actual, severity}",
        "recommendation{decision, amount, tenure_months, conditions}",
        "escalate (always true)",
      ],
      tools: [
        "bre.evaluate",
        "bre.explain",
        "graviton.get_application",
        "risk.score_dpd",
      ],
      rules: [
        "FOIR = (existing_monthly_emi + proposed_emi) / net_monthly_income, with proposed EMI from P·r·(1+r)^n / ((1+r)^n − 1).",
        "LTV = loan_amount / collateral_value. Caps come from the BRE, never from the model.",
        "The recommendation is advisory. escalate is always true for the decision itself.",
        "Every BRE failure is explained in plain language fit for an adverse-action note: no jargon, no protected attributes.",
        "Deviations route through the tenant's approval matrix by severity, L1 to L3.",
      ],
      escalateWhen: [
        "Always — a credit decision requires underwriter approval by design",
      ],
      evals: [
        "FOIR and LTV exact on the golden set",
        "BRE explanation rated 4 of 5 or better against the rubric",
        "No protected-attribute leakage (regex plus LLM judge)",
      ],
      aiServices: ["Language model (reasoning tier)"],
    },
  },

  // --- P1: risk, collections, voice, CX -----------------------------------
  {
    id: "risk_scoring",
    name: "Risk Agent",
    tier: "P1",
    summary:
      "Probability of 30+ DPD within 6 months, banded GREEN under 6%, AMBER 6-15%, RED above 15%. The probability comes from a versioned scorecard, never from the language model.",
    toolName: "score_risk",
    scopes: ["agents:run", "applications:read"],
    advisoryOnly: true,
    parityWith: "Risk scoring feeding Case Allocation",
    tags: ["risk", "scorecard"],
    detail: {
      purpose:
        "Estimate the probability of 30+ days past due within six months and band it. The architecture rule is absolute: the probability comes from a versioned, documented scorecard with published feature weights. The language model normalises features and writes the explanation — it never produces the number.",
      inputs: [
        "CAM and bank statement analytics output",
        "Bureau score, enquiries in 3 months, vintage",
        "FOIR, LTV, bounce count",
      ],
      outputKeys: [
        "model_version",
        "features{foir, bounces_6m, income_stability, bureau_score, enquiries_3m, vintage_months, ltv}",
        "probability_30dpd_6m",
        "band (GREEN | AMBER | RED)",
        "top_drivers[]{feature, contribution, direction}",
        "explanation",
      ],
      tools: ["gravai_agents/risk_scoring/model.py (offline-trained scorecard)"],
      rules: [
        "The probability is never generated by the language model.",
        "Bands are fixed: GREEN below 6%, AMBER 6 to 15%, RED above 15%.",
        "Top drivers must match the model's actual contributions, checked by an explanation-faithfulness eval.",
        "PSI is computed on every feature monthly; the calibration plot is visible in the console.",
      ],
      escalateWhen: [
        "Feature drift exceeds the PSI threshold",
        "A required feature is missing and cannot be imputed within policy",
      ],
      evals: [
        "Band agreement with labelled outcomes",
        "Explanation faithfulness: stated drivers match model contributions",
      ],
      aiServices: ["Language model (feature normalisation and explanation only)"],
    },
  },
  {
    id: "aa_data",
    name: "Account Aggregator Data Agent",
    tier: "P1",
    summary:
      "Fetches consented bank data through the RBI Account Aggregator framework and normalises it into the same shape the statement analytics consumes — structured at source, with no document extraction at all.",
    toolName: "fetch_consented_data",
    scopes: ["agents:run", "applications:read", "documents:read"],
    advisoryOnly: true,
    parityWith: "AA Orchestration",
    tags: ["aa", "data", "external_dependency"],
    detail: {
      purpose:
        "Pull bank data under a consent artefact and hand downstream agents exactly the transaction shape they already consume, so an application sourced through AA and one sourced from uploaded PDFs reach the same analytics rather than two divergent pipelines. Reading a statement costs roughly twelve API calls and a poll loop per document; a consented fetch costs one call, is structured at source, and carries no extraction risk. The fetch itself is an external dependency: real data requires being a registered Financial Information User behind a licensed Account Aggregator, and until that is in place every run says so and escalates.",
      inputs: [
        "customer_ref",
        "A consent artefact (id, purpose code, data range, fetch allowance, retention window)",
      ],
      outputKeys: [
        "consent{consent_id, status, purpose_code, data_range_from, data_range_to, expires_on, retention_expires_on, fetches_used, fetches_permitted}",
        "accounts[]{masked_account_number, fip_name, account_type, transaction_count}",
        "transactions[]{date, narration, amount, direction}",
        "live_data",
        "documents_avoided",
        "api_calls_avoided",
        "escalate",
        "reasoning_summary",
      ],
      tools: ["aa.fetch_fi_data", "aa.consent_status"],
      rules: [
        "A fetch is refused unless the artefact is ACTIVE, unexpired and within its permitted fetch count.",
        "Purpose limitation is enforced against the artefact: data consented for underwriting is never used for anything else.",
        "Only the consented date range is requested, never a wider window.",
        "Account numbers stay masked; the retention expiry travels with the data.",
        "Sandbox data is labelled on every run and can never underwrite a decision.",
      ],
      escalateWhen: [
        "The transport is not a licensed Account Aggregator (live_data is false)",
        "The consent artefact is expired, revoked, or its purpose does not permit the use",
        "The permitted fetch count is already exhausted",
      ],
      evals: [
        "Normalised output is byte-identical in shape to the statement path",
        "The same customer reaches the same underwriting conclusion by either route",
        "No fetch succeeds against an unusable artefact",
      ],
      aiServices: [],
    },
  },
  {
    id: "kyc_verification",
    name: "KYC & Identity Agent",
    tier: "P1",
    summary:
      "Cross-checks identity across DigiLocker, CKYC and uploaded documents. Aadhaar is handled masked to the last four digits throughout.",
    toolName: "verify_kyc",
    scopes: ["agents:run", "applications:read", "documents:read"],
    advisoryOnly: true,
    parityWith: null,
    tags: ["kyc", "identity"],
    detail: {
      purpose:
        "Cross-check the applicant's identity across DigiLocker-issued documents, CKYC records and uploaded KYC documents, handling Indian name orderings correctly and never touching a full Aadhaar number.",
      inputs: [
        "DigiLocker issued documents (consented)",
        "Uploaded KYC documents and their extractions",
        "Application applicant record",
      ],
      outputKeys: [
        "matches{name{score, method, evidence}, dob{match}, address{score}}",
        "aadhaar_last4",
        "pan",
        "flags[]",
        "escalate",
      ],
      tools: ["kyc.verify (DigiLocker connector)", "docai.extract"],
      rules: [
        "Fuzzy name matching handles Indian name orderings and initials — token sort plus phonetic, implemented in code.",
        "Date of birth must match exactly. There is no fuzzy tolerance on DOB.",
        "A full Aadhaar number is never stored, logged or emitted. Last four digits only.",
        "Expired documents are flagged.",
        "Face match is an interface hook only; choosing a vendor is a tenant decision.",
      ],
      escalateWhen: [
        "Name match score below 0.85",
        "Any date-of-birth or document-number mismatch",
      ],
      evals: [
        "Name-match precision and recall on an Indian-name golden set",
        "Zero full-Aadhaar emissions across the red-team suite",
      ],
      aiServices: ["Document intelligence (extraction)", "Language model (fast tier)"],
    },
  },
  {
    id: "case_allocation",
    name: "Collections Case Allocation Agent",
    tier: "P1",
    summary:
      "Ranks delinquent cases and routes the next best action to the right channel and queue, inside permitted calling hours.",
    toolName: "allocate_cases",
    scopes: ["agents:run", "collections:read", "collections:write"],
    advisoryOnly: true,
    parityWith: "Case Allocation",
    tags: ["collections"],
    detail: {
      purpose:
        "Rank a delinquent portfolio and assign each case a next best action, a channel and an owner — scored deterministically in code as recovery propensity multiplied by exposure multiplied by urgency, with the model explaining the ranking and handling policy exceptions.",
      inputs: [
        "Case list with DPD, POS, EMI, bounce history, risk band, contactability and promises",
        "Team capacities",
        "Tenant collections policy",
      ],
      outputKeys: [
        "allocations[]{case_id, priority, next_action, channel, reason, earliest_contact_at, assigned_to}",
        "summary",
        "escalate",
      ],
      tools: ["collections.list_cases", "risk.score_dpd"],
      rules: [
        "The score is computed in code. The model explains and handles exceptions.",
        "Calling windows and the DND registry are respected before a case is routed to voice.",
        "legal_review is never allocated without a human gate.",
        "earliest_contact_at always falls inside the tenant's permitted window.",
      ],
      escalateWhen: [
        "A case matches a hardship or dispute marker",
        "Capacity is insufficient for the cases above the priority threshold",
      ],
      evals: [
        "Allocation stability across reruns on an unchanged portfolio",
        "Zero allocations outside the permitted calling window",
      ],
      aiServices: ["Language model (explanation and exception handling)"],
    },
  },
  {
    id: "smart_mandate",
    name: "Smart Mandate Agent",
    tier: "P1",
    summary:
      "Picks the right customer, amount and date to present an e-NACH or UPI AutoPay mandate, respecting pre-debit notice and retry limits.",
    toolName: "plan_mandates",
    scopes: ["agents:run", "collections:read", "collections:write"],
    advisoryOnly: true,
    parityWith: "Smart Mandate",
    tags: ["collections", "payments"],
    detail: {
      purpose:
        "Decide which mandate to present, for how much and on which date — anchored to the salary-credit date the Bank Statement Analytics agent detected, and constrained by mandate caps, retry limits and the NPCI pre-debit notification requirement.",
      inputs: [
        "Mandate status and caps",
        "Salary-credit dates from bank statement analytics",
        "Balance patterns and past presentment outcomes",
      ],
      outputKeys: [
        "plans[]{case_id, present_on, amount, rationale, pre_debit_notice_at}",
        "skip[]{case_id, reason}",
        "escalate",
      ],
      tools: ["collections.get_case", "mandate.present (human-gated)"],
      rules: [
        "Amount never exceeds the registered mandate cap.",
        "Pre-debit notification is scheduled at least 24 hours ahead.",
        "Retry limits follow tenant policy; an exhausted case is skipped with a reason, not retried.",
        "Presentment is scheduled 1 to 3 days after the detected salary-credit date.",
      ],
      escalateWhen: [
        "A mandate is missing, expired or revoked",
        "The computed amount would exceed the cap",
      ],
      evals: [
        "Zero plans breaching the mandate cap or the pre-debit notice window",
        "Presentment-success uplift against a date-fixed control on the golden portfolio",
      ],
      aiServices: ["Language model (rationale)"],
    },
  },
  {
    id: "voice_collections",
    name: "Voice Collections Agent",
    tier: "P1",
    summary:
      "Multilingual pre-due and post-due calls: reminders, promise-to-pay capture, payment links, dispute detection and warm human handoff.",
    toolName: "run_collections_followup",
    scopes: ["agents:run", "collections:read", "collections:write"],
    advisoryOnly: false,
    parityWith: "Voice AI / Specialised Agents",
    tags: ["voice", "collections"],
    detail: {
      purpose:
        "Place and answer multilingual collections calls through a bounded conversation state machine: disclose that the caller is an AI assistant, verify identity without ever asking for Aadhaar, capture a promise to pay, send a payment link, detect a dispute and hand off warmly to a human. This is the one agent that is not advisory-only, so its guardrails are hard-coded rather than prompted.",
      inputs: [
        "Case record and outstanding amount",
        "Borrower's chosen language",
        "Tenant calling window and DND state",
      ],
      outputKeys: [
        "call_id",
        "language",
        "identity_verified",
        "outcome (ptp | paid | dispute | callback | no_answer | wrong_person | refused)",
        "ptp{date, amount}",
        "transcript_ref",
        "compliance{disclosed_ai, within_window, recording_consented}",
      ],
      tools: [
        "telephony.place / answer / stream / transfer",
        "speech.stt / tts / translate",
        "collections.get_case",
        "payments.create_link",
        "notifications.send",
      ],
      rules: [
        "Never threaten. Never imply legal action not authorised in the case file.",
        "Never discuss the debt with a third party.",
        "Never misrepresent the amount owed.",
        "Always offer a human on request; always speak the borrower's chosen language.",
        "Sentences stay at or under 20 words so synthesis sounds natural.",
        "Hard stops: outside the 08:00-19:00 IST window, DND registry hit, three unanswered attempts in a day, or the borrower asks not to be called.",
      ],
      escalateWhen: [
        "A dispute is detected",
        "The borrower reports hardship",
        "The borrower becomes hostile after one de-escalation attempt",
      ],
      evals: [
        "Scripted scenario suite of 30 dialogues including adversarial cases",
        "Compliance-phrase checks at 100%",
        "Promise-to-pay slot accuracy at or above 0.95",
        "Turn latency p50 at or below 1.5 seconds",
      ],
      aiServices: [
        "Speech to text (streaming)",
        "Text to speech",
        "Translation",
        "Language model (intent and slot extraction)",
      ],
    },
  },
  {
    id: "speech_analytics",
    name: "Speech Analytics Agent",
    tier: "P1",
    summary:
      "Scores every call, human or AI, for quality and compliance, quoting the transcript with timestamps for each finding.",
    toolName: "analyse_call",
    scopes: ["agents:run", "collections:read"],
    advisoryOnly: true,
    parityWith: "Speech Analytics",
    tags: ["voice", "quality"],
    detail: {
      purpose:
        "Score every call — whether an agent or a person made it — against a fixed quality and compliance rubric, and evidence each finding with a verbatim quote and a timestamp. A violation opens a review task rather than sitting in a report.",
      inputs: ["Diarised transcript", "Call metadata (window, channel, outcome)"],
      outputKeys: [
        "scores{disclosure, identity_verification, courtesy, accuracy_of_information, objection_handling, closure}",
        "compliance_violations[]{type, quote, timestamp}",
        "sentiment_timeline[]",
        "borrower_intent",
        "ptp_detected",
        "coaching_notes[]",
      ],
      tools: ["speech.stt (diarised)", "collections.get_case"],
      rules: [
        "Quotes must be verbatim from the transcript, with a timestamp.",
        "A finding without a quote is not a finding and is dropped.",
        "Violations raise a review task automatically.",
      ],
      escalateWhen: [
        "Any threat, third-party disclosure or misrepresentation is detected",
        "A call was placed outside the permitted window",
      ],
      evals: [
        "Quote verbatim-match 100%",
        "Violation detection recall against a labelled call set",
      ],
      aiServices: ["Speech to text (diarised)", "Language model (rubric scoring)"],
    },
  },
  {
    id: "onboarding_assistant",
    name: "Onboarding & Support Agent",
    tier: "P1",
    summary:
      "Guides applicants through the journey, explains requirements, chases pendencies and answers status questions in chat or voice.",
    toolName: "answer_borrower_query",
    scopes: ["agents:run", "applications:read"],
    advisoryOnly: true,
    parityWith: "Voice AI / Specialised Agents (onboarding, support)",
    tags: ["cx", "onboarding"],
    detail: {
      purpose:
        "Walk an applicant through the Graviton journey in their own language: explain what a document is for, chase outstanding pendencies, answer status questions, and surface the Key Fact Statement and grievance officer when asked.",
      inputs: [
        "application_id",
        "The borrower's message and chosen language",
        "Pendency list from Graviton",
      ],
      outputKeys: [
        "reply",
        "language",
        "pendencies_referenced[]",
        "handoff_requested",
        "escalate",
      ],
      tools: [
        "graviton.get_application",
        "graviton.list_pendencies",
        "notifications.send",
        "speech.stt / tts / translate",
      ],
      rules: [
        "Never quote an eligibility figure or interest rate that did not come from Graviton or the BRE.",
        "Explain the Key Fact Statement on request.",
        "Hand off to a human for complaints, with the grievance officer details from tenant configuration.",
        "English and Hindi are first-class; other languages route through translate.",
      ],
      escalateWhen: [
        "The borrower raises a complaint or grievance",
        "A question requires a credit judgement",
      ],
      evals: [
        "Zero unsourced rate or eligibility claims across the red-team suite",
        "Answer groundedness against the application record",
      ],
      aiServices: [
        "Language model",
        "Translation",
        "Speech to text and text to speech for the voice channel",
      ],
    },
  },

  // --- P2: intelligence and ops -------------------------------------------
  {
    id: "msme_underwriting",
    name: "MSME Underwriting Agent",
    tier: "P2",
    summary:
      "Cross-verifies GST returns, ITR, bank credits and invoices to underwrite thin-file MSME borrowers.",
    toolName: "underwrite_msme",
    scopes: ["agents:run", "applications:read", "documents:read"],
    advisoryOnly: true,
    parityWith: "MSME Underwriting",
    tags: ["credit", "msme"],
    detail: {
      purpose:
        "Underwrite a thin-file MSME borrower by reconciling four independent views of the same business: GST returns (GSTR-1 and 3B), the income tax return, bank credits and raised invoices. The gap between them is the signal.",
      inputs: [
        "GST returns",
        "ITR",
        "Bank statement analytics output",
        "Invoice extractions",
      ],
      outputKeys: [
        "turnover{gst_annual, bank_credits_annual, itr_declared, reconciliation_ratio}",
        "seasonality[]",
        "top_counterparties[]",
        "concentration_risk",
        "flags[]",
        "recommendation",
      ],
      tools: ["docai.extract", "graviton.get_application"],
      rules: [
        "GSTIN checksum validation is done in code, not by the model.",
        "A GST-versus-bank gap above 25% is flagged.",
        "Circular trading — the same counterparties appearing on both sides — is identified and flagged.",
      ],
      escalateWhen: ["Reconciliation ratio below 0.7"],
      evals: [
        "Turnover reconciliation within tolerance on the golden set",
        "Circular-trading detection recall",
      ],
      aiServices: ["Document Intelligence (extract)", "Language model (reasoning tier)"],
    },
  },
  {
    id: "customer_data_intelligence",
    name: "Customer Data Intelligence Agent",
    tier: "P2",
    summary:
      "Consent-scoped, explainable segments and propensities. Every segment carries a human-readable rule; no protected attributes are used.",
    toolName: "build_segments",
    scopes: ["agents:run", "applications:read"],
    advisoryOnly: true,
    parityWith: "Customer Data Intelligence",
    tags: ["analytics"],
    detail: {
      purpose:
        "Build explainable segments and propensities — top-up, cross-sell, churn and pre-delinquency — from platform signals, restricted to borrowers whose consent purpose actually covers marketing or servicing.",
      inputs: [
        "Platform signals across applications, cases and calls",
        "Consent registry entries with purpose and expiry",
      ],
      outputKeys: [
        "segments[]{id, rule, size, propensity}",
        "excluded{reason, count}",
        "escalate",
      ],
      tools: ["ledger.query (templated, read-only)"],
      rules: [
        "Only features whose consent purpose covers marketing or servicing are used.",
        "Every segment carries a human-readable rule — no opaque cluster ids.",
        "No protected attributes, directly or by proxy.",
        "Output feeds Graviton campaigns through the API. This agent never contacts a borrower.",
      ],
      escalateWhen: [
        "A requested segment would require a feature outside the consent purpose",
      ],
      evals: [
        "Zero protected-attribute usage (regex plus LLM judge)",
        "Consent-scope coverage 100% of included borrowers",
      ],
      aiServices: ["Language model (rule articulation)"],
    },
  },
  {
    id: "ops_research",
    name: "Ops & Research Agent",
    tier: "P2",
    summary:
      "Answers cost, volume and throughput questions from the ledger: calls per endpoint, extract versus digitise, utilisation against the 10/min ceiling, and backlog drain time.",
    toolName: "run_ops_report",
    scopes: ["agents:run", "usage:read"],
    advisoryOnly: true,
    parityWith: null,
    tags: ["ops", "cost"],
    detail: {
      purpose:
        "The productised research-agent mode. It answers cost, volume and throughput questions from the cost ledger and reproduces the platform's own capacity model: monthly calls by endpoint, the per-document call model for extract versus digitise, utilisation against the 10 requests per minute ceiling, and how long a backlog takes to drain under a given scenario.",
      inputs: [
        "A natural-language question",
        "A period",
        "The pinned rate card version",
      ],
      outputKeys: [
        "answer_markdown",
        "tables[]",
        "assumptions[]",
        "queries[] (the SQL behind every figure)",
        "rate_card_version",
      ],
      tools: [
        "ledger.query (templated read-only SQL over ledger views)",
        "docs.write_report",
      ],
      rules: [
        "Every figure is traceable to a query shown in the appendix.",
        "Sandbox and production rows are never mixed in one report.",
        "A rate card version is always named. A cost without a rate card version is not reported.",
        "Outputs are Markdown, XLSX with live formulas, and JSON.",
      ],
      escalateWhen: [
        "A question cannot be answered from the ledger without an assumption the user has not supplied",
      ],
      evals: [
        "Reproduces the reference volume model exactly",
        "Every reported figure resolves to a query that returns it",
      ],
      aiServices: ["Language model (reasoning tier)"],
    },
  },
];

export const AGENTS_BY_ID: Record<string, Agent> = Object.fromEntries(
  AGENTS.map((agent) => [agent.id, agent]),
);

export function getAgent(id: string): Agent | undefined {
  return AGENTS_BY_ID[id];
}

export const TIERS: { tier: AgentTier; label: string; description: string }[] = [
  {
    tier: "P0",
    label: "P0 — the credit core",
    description:
      "The three agents that carry an application from uploaded documents to a Credit Appraisal Memorandum.",
  },
  {
    tier: "P1",
    label: "P1 — risk, collections, voice, customer experience",
    description:
      "Scoring, identity, portfolio allocation, mandates, the voice channel and the quality loop over it.",
  },
  {
    tier: "P2",
    label: "P2 — intelligence and operations",
    description:
      "Thin-file MSME underwriting, consent-scoped segmentation, and the platform's own cost and throughput model.",
  },
];

export const TIER_COUNTS: Record<AgentTier, number> = AGENTS.reduce(
  (counts, agent) => {
    counts[agent.tier] += 1;
    return counts;
  },
  { P0: 0, P1: 0, P2: 0 } as Record<AgentTier, number>,
);
