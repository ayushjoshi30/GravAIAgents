/**
 * The workflow node registry, as static data.
 *
 * GENERATED FILE — do not edit by hand. Run `python scripts/gen_node_catalog.py`
 * and commit the result. `tests/test_node_catalog.py` fails if this drifts from
 * the engine's own registry.
 *
 * WHY IT IS GENERATED. The console fetches its node library from the API, which
 * needs a tenant token — see the note at the top of `studio.ts`. The public
 * sketchpad at /build has no token, so it needs the list at build time. Writing
 * that list by hand would create a second description of the platform that goes
 * stale the first time a node is added, with nothing to catch it. Generating it
 * means the public page is wrong only when the engine is wrong.
 *
 * `usesLlm` and `deterministic` are the two flags the interface actually reads:
 * they drive the one thing colour means here — teal is a language model
 * reasoning, navy is deterministic code. `branching` marks the nodes drawn as a
 * decision diamond rather than a card.
 *
 * 31 node types across 6 families, from `gravai_workflow.NODE_REGISTRY`.
 */

export interface CatalogNode {
  type: string;
  label: string;
  summary: string;
  icon: string;
  /** True when this node calls a language model. Drawn teal. */
  usesLlm: boolean;
  /** True when this node is code with a fixed answer. Drawn navy. */
  deterministic: boolean;
  /** True when this node sends the run down one of several branches. */
  branching: boolean;
  /** A limitation worth stating before someone places the node. */
  caveat: string | null;
  /** Palette key. Resolves to --gv-hue-<hue>-* tokens. See the generator for why. */
  hue: string;
}

export interface CatalogFamily {
  key: string;
  label: string;
  nodes: CatalogNode[];
}

export const NODE_CATALOG: CatalogFamily[] = [
  {
    "key": "gravai",
    "label": "Agents",
    "nodes": [
      {
        "type": "agent.aa_data",
        "label": "Account Aggregator Data Agent",
        "summary": "Fetches consented bank data through the RBI Account Aggregator framework and normalises it into the same shape the statement analytics consumes — structured at source, with no document extraction at all.",
        "icon": "aa_data",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "cyan"
      },
      {
        "type": "agent.bank_statement_analytics",
        "label": "Bank Statement Analytics Agent",
        "summary": "Turns 6-12 months of statements into income, obligations, bounces and balance behaviour, reconciled month by month.",
        "icon": "bank_statement_analytics",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "blue"
      },
      {
        "type": "agent.case_allocation",
        "label": "Collections Case Allocation Agent",
        "summary": "Ranks delinquent cases and routes the next best action to the right channel and queue, inside permitted calling hours.",
        "icon": "case_allocation",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "rose"
      },
      {
        "type": "agent.credit_appraisal",
        "label": "Credit Appraisal Agent",
        "summary": "Produces the Credit Appraisal Memorandum: eligibility with FOIR and LTV, income build-up, cross-checks, deviation matrix, and a plain-language explanation of every BRE pass and fail.",
        "icon": "credit_appraisal",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "indigo"
      },
      {
        "type": "agent.customer_data_intelligence",
        "label": "Customer Data Intelligence Agent",
        "summary": "Consent-scoped, explainable segments and propensities. Every segment carries a human-readable rule; no protected attributes are used.",
        "icon": "customer_data_intelligence",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "cyan"
      },
      {
        "type": "agent.doc_intelligence",
        "label": "Document Intelligence Agent",
        "summary": "Classifies every uploaded document, routes it to extract or digitise, and returns structured fields with a citation for each value.",
        "icon": "doc_intelligence",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "teal"
      },
      {
        "type": "agent.kyc_verification",
        "label": "KYC & Identity Agent",
        "summary": "Cross-checks identity across DigiLocker, CKYC and uploaded documents. Aadhaar is handled masked to the last four digits throughout.",
        "icon": "kyc_verification",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "violet"
      },
      {
        "type": "agent.msme_underwriting",
        "label": "MSME Underwriting Agent",
        "summary": "Cross-verifies GST returns, ITR, bank credits and invoices to underwrite thin-file MSME borrowers.",
        "icon": "msme_underwriting",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "green"
      },
      {
        "type": "agent.onboarding_assistant",
        "label": "Onboarding & Support Agent",
        "summary": "Guides applicants through the journey, explains requirements, chases pendencies and answers status questions in chat or voice.",
        "icon": "onboarding_assistant",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "violet"
      },
      {
        "type": "agent.ops_research",
        "label": "Ops & Research Agent",
        "summary": "Answers cost, volume and throughput questions from the ledger: calls per endpoint, extract versus digitise, utilisation against the 10/min ceiling, and backlog drain time.",
        "icon": "ops_research",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "slate"
      },
      {
        "type": "agent.risk_scoring",
        "label": "Risk Agent",
        "summary": "Probability of 30+ DPD within 6 months, banded GREEN under 6%, AMBER 6-15%, RED above 15%. The probability comes from a versioned scorecard, never from the language model.",
        "icon": "risk_scoring",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "amber"
      },
      {
        "type": "agent.smart_mandate",
        "label": "Smart Mandate Agent",
        "summary": "Picks the right customer, amount and date to present an e-NACH or UPI AutoPay mandate, respecting pre-debit notice and retry limits.",
        "icon": "smart_mandate",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "indigo"
      },
      {
        "type": "agent.speech_analytics",
        "label": "Speech Analytics Agent",
        "summary": "Scores every call, human or AI, for quality and compliance, quoting the transcript with timestamps for each finding.",
        "icon": "speech_analytics",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "pink"
      },
      {
        "type": "agent.voice_collections",
        "label": "Voice Collections Agent",
        "summary": "Multilingual pre-due and post-due calls: reminders, promise-to-pay capture, payment links, dispute detection and warm human handoff.",
        "icon": "voice_collections",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "orange"
      }
    ]
  },
  {
    "key": "data",
    "label": "Sources & tools",
    "nodes": [
      {
        "type": "http",
        "label": "API Call",
        "summary": "A GET against an endpoint you control, with the same guard as the source.",
        "icon": "globe",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "blue"
      },
      {
        "type": "document_source",
        "label": "Document Source",
        "summary": "Fetches real documents or already-extracted facts from your endpoint.",
        "icon": "database",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": "Returns facts usable immediately. Raw documents still need the document-AI layer configured before anything reads them.",
        "hue": "navy"
      },
      {
        "type": "mcp",
        "label": "MCP Tool",
        "summary": "Calls a tool on an MCP server over Streamable HTTP.",
        "icon": "terminal",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "teal"
      }
    ]
  },
  {
    "key": "intelligence",
    "label": "Models",
    "nodes": [
      {
        "type": "classifier",
        "label": "Classifier",
        "summary": "Puts the state into one of a fixed set of labels.",
        "icon": "grid",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "teal"
      },
      {
        "type": "extractor",
        "label": "Extractor",
        "summary": "Pulls named fields out of text into facts.",
        "icon": "file",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "teal"
      },
      {
        "type": "llm",
        "label": "LLM Agent",
        "summary": "Reasons over the state and returns prose or structured JSON.",
        "icon": "bolt",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "teal"
      },
      {
        "type": "summarizer",
        "label": "Summarizer",
        "summary": "Compresses part of the state into a few sentences.",
        "icon": "book",
        "usesLlm": true,
        "deterministic": false,
        "branching": false,
        "caveat": null,
        "hue": "indigo"
      }
    ]
  },
  {
    "key": "business",
    "label": "Rules & maths",
    "nodes": [
      {
        "type": "bre",
        "label": "Business Rule Engine",
        "summary": "Evaluates the tenant's policy rules. Deterministic, and final.",
        "icon": "shield",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": "A model node cannot overturn this; the engine refuses the write.",
        "hue": "amber"
      },
      {
        "type": "calculator",
        "label": "Calculator",
        "summary": "Reads a figure out of the state and records it under a name. No model involved.",
        "icon": "chart",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": "This build resolves a path; it does not compute. The expression grammar has no arithmetic operators, so `monthly_income * 12` is refused on the canvas rather than failing part way through a run.",
        "hue": "slate"
      },
      {
        "type": "validator",
        "label": "Validator",
        "summary": "Asserts a condition holds, and records a warning when it does not.",
        "icon": "check",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "blue"
      }
    ]
  },
  {
    "key": "control",
    "label": "Flow",
    "nodes": [
      {
        "type": "condition",
        "label": "Condition",
        "summary": "A two-way branch on one expression.",
        "icon": "activity",
        "usesLlm": false,
        "deterministic": true,
        "branching": true,
        "caveat": null,
        "hue": "indigo"
      },
      {
        "type": "human_approval",
        "label": "Human Approval",
        "summary": "Stops the run and raises a review task. Nothing past it executes.",
        "icon": "inbox",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": "A genuine halt: the run ends as `awaiting_approval` rather than continuing.",
        "hue": "violet"
      },
      {
        "type": "input",
        "label": "Input",
        "summary": "Where the workflow starts. Its fields become the first facts.",
        "icon": "inbox",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "violet"
      },
      {
        "type": "output",
        "label": "Output",
        "summary": "The workflow's final answer, assembled from the state.",
        "icon": "check",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "blue"
      },
      {
        "type": "router",
        "label": "Router",
        "summary": "Sends the run down one branch. Conditions are deterministic.",
        "icon": "activity",
        "usesLlm": false,
        "deterministic": true,
        "branching": true,
        "caveat": null,
        "hue": "indigo"
      }
    ]
  },
  {
    "key": "memory",
    "label": "Memory",
    "nodes": [
      {
        "type": "context_compiler",
        "label": "Context Compiler",
        "summary": "Selects what the next node needs to know, instead of passing everything.",
        "icon": "chain",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "rose"
      },
      {
        "type": "set_state",
        "label": "Workflow State",
        "summary": "Writes named facts directly.",
        "icon": "database",
        "usesLlm": false,
        "deterministic": true,
        "branching": false,
        "caveat": null,
        "hue": "slate"
      }
    ]
  }
];

export const NODE_BY_TYPE: Record<string, CatalogNode> = Object.fromEntries(
  NODE_CATALOG.flatMap((family) => family.nodes.map((node) => [node.type, node])),
);
