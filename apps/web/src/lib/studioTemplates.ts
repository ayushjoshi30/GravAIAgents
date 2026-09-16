/**
 * Workflows you can start from, instead of an empty canvas.
 *
 * An empty canvas is the worst first screen a builder can offer. It asks
 * someone who has just arrived to know both what the platform can do and how
 * they want to arrange it, and most people know neither on the first visit.
 * Starting from a real workflow lets them delete what they do not want, which
 * is a far easier judgement than inventing what they do.
 *
 * EVERY TEMPLATE IS REAL. Each node below names a type from the engine's own
 * registry — the same registry `/v1/studio/nodes` serves and the same one
 * `lib/nodeCatalog.ts` is generated from. A template that referenced a node
 * this build does not have would validate as "not a node type this build
 * knows" the moment it was saved, which is a worse first experience than the
 * empty canvas it replaced. `tests/test_studio_templates.py` fails if any type
 * here stops existing.
 *
 * WHAT THE NODES DO AND DO NOT CARRY. Positions are laid out on a rough grid so
 * a template opens looking deliberate. Config is left close to empty on
 * purpose: a template is a SHAPE, not a configuration. Filling in prompts,
 * thresholds and mappings would be inventing policy on behalf of a tenant whose
 * credit rules we do not know, and a plausible-looking threshold someone forgot
 * to change is exactly the kind of thing that ends up in production.
 *
 * The one exception is the Input node, which carries no schema at all. See the
 * note on INPUT_CONFIG below.
 */

import type { WorkflowDefinition, WorkflowNode } from "@/lib/studio";

/**
 * The Input node's config, deliberately empty.
 *
 * `blankWorkflow()` used to seed `{ schema: { loan_id: "string" } }`, which read
 * like a requirement and was not one; it seeds nothing now, and the templates
 * agree with it. In the engine, `input`'s `schema` field is
 * declared `required=False`, and the node's only output port is
 * `payload: object` — "Whatever the caller sent". Downstream, every agent node
 * takes exactly one input, `state: object`, also optional, described as "Reads
 * the shared workflow state".
 *
 * So nothing in a workflow is typed node-to-node. A step reads the shared state
 * that earlier steps wrote, which is what you would want when the input to an
 * agent is usually another agent's output, or a payload an API just posted in
 * whatever shape that API uses. Declaring a schema is available when a tenant
 * wants their endpoint to reject malformed calls early; it is not a step on the
 * way to a working workflow, and a template should not imply that it is.
 */
const INPUT_CONFIG: Record<string, unknown> = {};

/** Grid spacing, so every template is laid out on the same rhythm. */
const COL = 330;
const ROW = 190;

function node(
  id: string,
  type: string,
  name: string,
  col: number,
  row: number,
  config: Record<string, unknown> = {},
): WorkflowNode {
  return { id, type, name, config, position: { x: 60 + col * COL, y: 90 + row * ROW } };
}

function edge(source: string, target: string, branch = "") {
  return { id: `${source}->${target}${branch ? `:${branch}` : ""}`, source, target, branch };
}

export interface StudioTemplate {
  id: string;
  /** What it is called in the picker. */
  label: string;
  /** One line: what this workflow decides, and who it hands the decision to. */
  blurb: string;
  /** Builds a fresh definition. A function so two people opening the same
   *  template never share a mutable object. */
  build: () => WorkflowDefinition;
}

export const STUDIO_TEMPLATES: StudioTemplate[] = [
  {
    id: "credit",
    label: "Credit agent",
    blurb:
      "Reads the documents and the statements, scores the risk, and puts anything outside the green band in front of an underwriter.",
    build: () => ({
      name: "Credit agent",
      description:
        "Retail loan decisioning end to end: document intelligence, statement analytics, a risk score, and a human for everything the policy does not clear outright.",
      nodes: [
        node("input", "input", "Application received", 0, 1, INPUT_CONFIG),
        node("doc_intelligence", "agent.doc_intelligence", "Read the documents", 1, 0),
        node("bank_statements", "agent.bank_statement_analytics", "Read the statements", 1, 2),
        node("risk_scoring", "agent.risk_scoring", "Score the risk", 2, 1),
        node("band", "condition", "Risk band is GREEN", 3, 1),
        node("credit_appraisal", "agent.credit_appraisal", "Write the memorandum", 4, 0),
        node("human_approval", "human_approval", "Underwriter decides", 4, 2),
        node("output", "output", "Decision", 5, 1),
      ],
      edges: [
        edge("input", "doc_intelligence"),
        edge("input", "bank_statements"),
        edge("doc_intelligence", "risk_scoring"),
        edge("bank_statements", "risk_scoring"),
        edge("risk_scoring", "band"),
        // A branching node's edges must name a branch it declares, or the graph
        // fails validation. `condition` declares true/false.
        edge("band", "credit_appraisal", "true"),
        edge("band", "human_approval", "false"),
        edge("credit_appraisal", "output"),
        edge("human_approval", "output"),
      ],
    }),
  },
  {
    id: "msme",
    label: "MSME underwriting",
    blurb:
      "Cross-verifies GST and bank data for a business borrower, then routes the file to a person for the final call.",
    build: () => ({
      name: "MSME underwriting",
      description:
        "Business lending: consented bank data and statement analytics feed MSME underwriting, and a person signs the decision.",
      nodes: [
        node("input", "input", "Application received", 0, 1, INPUT_CONFIG),
        node("aa_data", "agent.aa_data", "Fetch consented bank data", 1, 0),
        node("bank_statements", "agent.bank_statement_analytics", "Read the statements", 1, 2),
        node("msme", "agent.msme_underwriting", "Underwrite the business", 2, 1),
        node("human_approval", "human_approval", "Credit head decides", 3, 1),
        node("output", "output", "Decision", 4, 1),
      ],
      edges: [
        edge("input", "aa_data"),
        edge("input", "bank_statements"),
        edge("aa_data", "msme"),
        edge("bank_statements", "msme"),
        edge("msme", "human_approval"),
        edge("human_approval", "output"),
      ],
    }),
  },
  {
    id: "onboarding",
    label: "Onboarding and KYC",
    blurb:
      "Checks identity across the documents a borrower sent, and escalates only the ones that do not reconcile.",
    build: () => ({
      name: "Onboarding and KYC",
      description:
        "Identity and document checks at the front of the journey, with an assistant answering the applicant and a person handling the exceptions.",
      nodes: [
        node("input", "input", "Applicant arrives", 0, 1, INPUT_CONFIG),
        node("doc_intelligence", "agent.doc_intelligence", "Read the documents", 1, 1),
        node("kyc", "agent.kyc_verification", "Verify identity", 2, 1),
        node("clean", "condition", "Identity reconciles", 3, 1),
        node("onboarding", "agent.onboarding_assistant", "Tell the applicant", 4, 0),
        node("human_approval", "human_approval", "Ops reviews the exception", 4, 2),
        node("output", "output", "Onboarding outcome", 5, 1),
      ],
      edges: [
        edge("input", "doc_intelligence"),
        edge("doc_intelligence", "kyc"),
        edge("kyc", "clean"),
        edge("clean", "onboarding", "true"),
        edge("clean", "human_approval", "false"),
        edge("onboarding", "output"),
        edge("human_approval", "output"),
      ],
    }),
  },
  {
    id: "collections",
    label: "Collections follow-up",
    blurb:
      "Ranks delinquent cases, plans the mandate, and reviews what was said on the call afterwards.",
    build: () => ({
      name: "Collections follow-up",
      description:
        "Allocation, a presentment plan and a call, with speech analytics reading the recording back for compliance.",
      nodes: [
        node("input", "input", "Portfolio slice", 0, 1, INPUT_CONFIG),
        node("allocation", "agent.case_allocation", "Rank the cases", 1, 1),
        node("mandate", "agent.smart_mandate", "Plan the presentment", 2, 0),
        node("voice", "agent.voice_collections", "Make the call", 2, 2),
        node("speech", "agent.speech_analytics", "Review the recording", 3, 2),
        node("output", "output", "Follow-up outcome", 4, 1),
      ],
      edges: [
        edge("input", "allocation"),
        edge("allocation", "mandate"),
        edge("allocation", "voice"),
        edge("voice", "speech"),
        edge("mandate", "output"),
        edge("speech", "output"),
      ],
    }),
  },
];

/** Every node type any template depends on. The test reads this. */
export const TEMPLATE_NODE_TYPES: string[] = [
  ...new Set(STUDIO_TEMPLATES.flatMap((t) => t.build().nodes.map((n) => n.type))),
].sort();
