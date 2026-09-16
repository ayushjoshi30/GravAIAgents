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
 * There are three exceptions, and each one is argued where it sits. The Input
 * node carries no schema at all, for the reason set out on INPUT_CONFIG below.
 * The Credit agent's risk node carries a narration prompt and the shape of the
 * reply, for the reason set out on NARRATE_THE_SCORE. And the MSME template's
 * MCP node carries an explicitly blank server and tool, which is not the same
 * thing as carrying nothing: see the note where it is placed.
 *
 * WHERE "EMPTY CONFIG" IS NOT EMPTY. `_setting()` in the engine reads
 * `node.config.get(name, spec_default)`, so a setting a template omits is a
 * setting the engine fills in from the registry's default at run time, while
 * the config panel shows the box blank. For most fields the default is itself
 * blank and the two agree. Where a registry default is NOT blank, a template
 * that omits the field is quietly shipping that default under a blank box, and
 * the only safe habit is to write the blank out. That is the whole argument on
 * the MCP node below, and it is why anything added here should be checked
 * against the registry rather than against the panel.
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

/**
 * The narration asked for on the Credit agent's risk node.
 *
 * This sits on `agent.risk_scoring` itself rather than on a separate `llm` node
 * placed after it, and the difference is not presentational. An agent node's
 * `prompt` and `output_schema` run inside `_agent_executor`, after the score
 * exists: the scored payload is copied through verbatim, the model's answer is
 * put beside it under `narration`, and asking for a key the agent itself
 * produces is refused in the engine with a warning rather than honoured. The
 * agent's own `publish_facts` is applied to the scored payload before the model
 * is called at all, so there is no route — not even a wrong config — by which a
 * generated value reaches the facts a later `condition` branches on.
 *
 * A standalone `llm` node reading `{{nodes.risk_scoring.*}}` produces similar
 * words and none of that. Its output is an arbitrary object, its `publish_facts`
 * will write whatever keys the model returned straight into the facts, and in a
 * shape where the next node is the branch that decides the loan, the distance
 * between the starter and a decision that turns on generated text is one field
 * in a config panel. Starters are copied, so the starter has to be the shape
 * that cannot go wrong, not the shape that happens not to have yet.
 *
 * WHY THE PROMPT IS WORDED THE WAY IT IS. By the time this runs, the scorecard
 * has decided. `_narrate` appends the agent's whole result to the prompt, so
 * the wording does not restate the figures — restating them by expression would
 * add half a dozen `{{...}}` references that render leniently, which means a
 * single typo ships literal braces to the model and comes back as prose about
 * nothing. `{{result.model_version}}` is the one reference kept, because the
 * form is worth teaching and the test checks it names a real port. What the
 * prompt asks for is sentences. It never asks for a probability, a band, a
 * score or a recommendation, because arithmetic comes from code and language
 * comes from the model — a generated number that looks like a scored one is the
 * single failure this platform cannot have, and teaching that habit on the
 * template most people open first is how it would spread.
 *
 * WHY THESE KEYS. `output_schema` here maps a field name to a description of
 * what belongs in it, not to a type — that is what the registry's help text
 * asks for and what `_narrate` passes to the model. Both names say "prose" out
 * loud and neither could be mistaken for a figure or a verdict, which matters
 * because the keys are the machine-readable statement of what this node asks a
 * model to produce. They also avoid every name the agents in these templates
 * return — risk scoring has its own `explanation` and its own
 * `reasoning_summary` — so nobody reading a run has to work out whether a field
 * is the scorecard accounting for itself or the model retelling it.
 * `tests/test_studio_templates.py` holds all three of those lines.
 */
const NARRATE_THE_SCORE: Record<string, unknown> = {
  prompt: [
    "Scorecard {{result.model_version}} has already scored this application, and " +
      "its full result is below.",
    "",
    "Write the note an underwriter reads before opening the file: what the top " +
      "drivers say about this borrower in plain English, and what the imputed " +
      "values leave unanswered. Where you mention the probability or the band, " +
      "quote them exactly as they stand in the result.",
    "",
    "Do not offer a probability, a band, a score or a recommendation of your " +
      "own. That call is already made, by code, and your work here is to put it " +
      "into words a person can act on.",
  ].join("\n"),
  output_schema: {
    plain_english:
      "Two or three sentences putting the drivers above into the words an " +
      "underwriter would use. Describe what the scorecard found; do not restate " +
      "it as a judgement of your own.",
    open_questions:
      "What the imputed values leave unanswered, as a list of things a person " +
      "could go and check before this file is decided.",
  },
};

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
      "Reads the documents and the statements, scores the risk, writes the explanation a person reads, and puts anything outside the green band in front of an underwriter.",
    build: () => ({
      name: "Credit agent",
      description:
        "Retail loan decisioning end to end: document intelligence, statement analytics, a risk score, the explanation that goes with it, and a human for everything the policy does not clear outright.",
      nodes: [
        node("input", "input", "Application received", 0, 1, INPUT_CONFIG),
        node("doc_intelligence", "agent.doc_intelligence", "Read the documents", 1, 0),
        node("bank_statements", "agent.bank_statement_analytics", "Read the statements", 1, 2),
        // The explanation lives on the scoring node, not on a node after it.
        // The words and the figures they describe come out of one step, in one
        // place in the trace, and the reviewer who reaches the branch has
        // already been handed the reason it will go the way it goes. What this
        // node may and may not be asked to say is argued on NARRATE_THE_SCORE.
        node("risk_scoring", "agent.risk_scoring", "Score the risk", 2, 1, NARRATE_THE_SCORE),
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
      "Cross-verifies GST and bank data for a business borrower, adds whatever your own systems know, then routes the file to a person for the final call.",
    build: () => ({
      name: "MSME underwriting",
      description:
        "Business lending: consented bank data, statement analytics and a tool of your own feed MSME underwriting, and a person signs the decision.",
      nodes: [
        node("input", "input", "Application received", 0, 1, INPUT_CONFIG),
        node("aa_data", "agent.aa_data", "Fetch consented bank data", 1, 0),
        // Where data that is not ours enters the workflow. One template shows
        // this door, and this is the one where it belongs: a business borrower
        // is usually already known to the lender's own systems, so the file is
        // thinner than it should be until those systems are asked.
        //
        // The server and the tool are written out as blank on purpose, and this
        // is the one place a template must not simply omit a setting. `mcp`
        // declares both as required with registry defaults of
        // `https://credit.pilotpod.in/mcp` and `score_risk`, and a template that
        // left them out would inherit those: the panel would show two empty
        // boxes while a run of the untouched starter called this platform's own
        // retail scorecard on fixture inputs and dropped a 30+ DPD probability
        // into the trace of a business-lending workflow. A figure nobody asked
        // for, about a borrower it was not computed from, is fabricated data
        // however real the code that produced it.
        //
        // Blank instead makes the node fail validation with "needs MCP server"
        // until the tenant names theirs. That is a starter that cannot be
        // deployed unedited, which is the correct trade: the message names the
        // two fields to fill in, and the alternative is a wrong answer given
        // quietly.
        node("mcp_tool", "mcp", "Call a tool on your MCP server", 1, 1, {
          server: "",
          tool: "",
        }),
        node("bank_statements", "agent.bank_statement_analytics", "Read the statements", 1, 2),
        node("msme", "agent.msme_underwriting", "Underwrite the business", 2, 1),
        node("human_approval", "human_approval", "Credit head decides", 3, 1),
        node("output", "output", "Decision", 4, 1),
      ],
      edges: [
        edge("input", "aa_data"),
        edge("input", "mcp_tool"),
        edge("input", "bank_statements"),
        edge("aa_data", "msme"),
        edge("mcp_tool", "msme"),
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
