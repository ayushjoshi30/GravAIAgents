import type { Metadata } from "next";
import Link from "next/link";
import { hueStyle } from "@/components/build/blocks";
import { AGENTS, TIERS } from "@/lib/agents";
import { NODE_BY_TYPE } from "@/lib/nodeCatalog";

export const metadata: Metadata = {
  title: "Agent reference",
  description:
    "Generated reference for all fourteen GravAI agents: MCP tool name, required scopes, authority, tools, guardrails, escalation triggers and eval gates.",
};

/** The agent's hue, from the generated node registry. Never chosen here. */
function agentHue(id: string): string {
  return NODE_BY_TYPE[`agent.${id}`]?.hue ?? "slate";
}

/**
 * The agent's colour chip, as it appears everywhere else in the product.
 *
 * A reference page is read with a console or a canvas open beside it, and the
 * one thing that page cannot otherwise offer is "this is the agent whose nodes
 * are the blue ones". The chip is `aria-hidden` and always sits against the
 * agent's own name: it is a convenience for a reader matching this page to a
 * screen, never the way anything here is identified. The reference loses
 * nothing at all with colour switched off.
 */
function HueMark({ id }: { id: string }) {
  return (
    <span
      aria-hidden="true"
      style={hueStyle(agentHue(id))}
      className="mr-2 inline-block h-2.5 w-2.5 rounded-[3px] bg-[var(--plate-accent)] align-middle"
    />
  );
}

/**
 * Generated from src/lib/agents.ts, which transcribes the platform's own
 * catalog. Editing this page by hand would let the documentation drift away
 * from the registry the API and the MCP server read.
 */
export default function AgentReferencePage() {
  return (
    <>
      <h1>Agent reference</h1>
      <p>
        Generated from the agent catalog. Every field below comes from{" "}
        <code>packages/gravai_agents/catalog.py</code> or from the agent specifications in
        section 4 of the platform specification. If an agent is not in that catalog, it is
        not in this reference and it is not on this site.
      </p>
      <p>
        The square beside each name is that agent&apos;s colour, generated from the engine&apos;s
        node registry. It is the same colour the agent wears in the catalog, on its own page
        and on the studio canvas, which is what makes this reference matchable to a screen at
        a glance. Nothing on this page is identified by it.
      </p>

      <h2>Index</h2>
      <table>
        <thead>
          <tr>
            <th>Agent</th>
            <th>Tier</th>
            <th>MCP tool</th>
            <th>Authority</th>
          </tr>
        </thead>
        <tbody>
          {AGENTS.map((agent) => (
            <tr key={agent.id}>
              <td>
                <HueMark id={agent.id} />
                <a href={`#${agent.id}`}>{agent.name}</a>
              </td>
              <td>
                <code>{agent.tier}</code>
              </td>
              <td>
                <code>{agent.toolName}</code>
              </td>
              <td>{agent.advisoryOnly ? "Advisory only" : "Acts"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {TIERS.map((tier) => (
        <section key={tier.tier}>
          <h2 id={tier.tier.toLowerCase()}>{tier.label}</h2>
          <p>{tier.description}</p>

          {AGENTS.filter((agent) => agent.tier === tier.tier).map((agent) => (
            <section key={agent.id}>
              <h3 id={agent.id}>
                <HueMark id={agent.id} />
                {agent.name} — <code>{agent.id}</code>
              </h3>
              <p>{agent.detail.purpose}</p>

              <table>
                <tbody>
                  <tr>
                    <th scope="row">MCP tool</th>
                    <td>
                      <code>{agent.toolName}</code>
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Scopes</th>
                    <td>
                      {agent.scopes.map((scope, index) => (
                        <span key={scope}>
                          {index > 0 ? ", " : ""}
                          <code>{scope}</code>
                        </span>
                      ))}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Authority</th>
                    <td>
                      {agent.advisoryOnly
                        ? "Advisory only — never takes an irreversible action on its own."
                        : "Acts. Guardrails are enforced in code rather than prompted."}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">Parity</th>
                    <td>{agent.parityWith ?? "No direct market equivalent named."}</td>
                  </tr>
                  <tr>
                    <th scope="row">Tags</th>
                    <td>{agent.tags.join(", ")}</td>
                  </tr>
                </tbody>
              </table>

              <p>
                <strong>Inputs.</strong> {agent.detail.inputs.join(" · ")}
              </p>
              <p>
                <strong>Tools it may call.</strong> {agent.detail.tools.join(" · ")}
              </p>
              <p>
                <strong>AI capabilities.</strong> {agent.detail.aiServices.join(" · ")}
              </p>

              <p>
                <strong>Output contract — top-level keys</strong>
              </p>
              <pre>
                <code>{agent.detail.outputKeys.join("\n")}</code>
              </pre>

              <p>
                <strong>Guardrails</strong>
              </p>
              <ul>
                {agent.detail.rules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>

              <p>
                <strong>Escalates when</strong>
              </p>
              <ul>
                {agent.detail.escalateWhen.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <p>
                <strong>Eval gates</strong>
              </p>
              <ul>
                {agent.detail.evals.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>

              <p>
                <Link href={`/agents/${agent.id}`}>Agent page for {agent.name}</Link>
              </p>
            </section>
          ))}
        </section>
      ))}
    </>
  );
}
