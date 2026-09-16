# Agent Studio

Agent Studio is the part of the platform where somebody draws a workflow on a
canvas and the platform runs it as one agent. This document is for the person
who has just been handed the code and has to change something in it.

Everything below names real files and real functions. Where a thing does not
work yet, it says so rather than describing what it would do.

---

## 1. The layering

There are two halves and one artefact between them.

**The frontend edits a definition.** `apps/web/src/app/console/studio/page.tsx`
and the components beside it in `apps/web/src/components/studio/` — `Canvas`,
`NodeLibrary`, `ConfigPanel`, `TestPanel`, `DeployPanel` — do nothing but
produce and mutate a JSON object. The canvas never decides what a node means.
It does not know that a rule engine is deterministic or that an approval gate
stops a run; it renders whatever the backend told it exists, from the node
library it fetched at load. `apps/web/src/lib/studio.ts` says this plainly in
its own header, and it is worth taking literally: there is no node type
hard-coded in the frontend.

**The backend executes that definition.** `packages/gravai_workflow/` takes the
same JSON, validates it, and runs it. It has no opinion about pixels; node
positions travel through it untouched because the canvas needs them and nothing
else does.

**The artefact between them is a plain dictionary.** `graph.from_dict` and
`graph.to_dict` in
`packages/gravai_workflow/src/gravai_workflow/graph.py` are the whole contract,
and the TypeScript interfaces `WorkflowDefinition`, `WorkflowNode` and
`WorkflowEdge` in `apps/web/src/lib/studio.ts` are the same shape written twice
in two languages.

### Why the separation is worth the duplication

The obvious alternative is to let the canvas hold the behaviour — each node a
component that knows how to run itself, with the backend reduced to a proxy.
That design is quicker for about a fortnight and then it is wrong for good, for
three reasons.

The first is trust. A router condition is part of a lending decision. If the
browser evaluates it, the decision was made on a machine the lender does not
control by code the applicant could edit. Every condition in this system is
evaluated server-side in `expressions.py`, and the browser is never told the
answer before the server has it.

The second is that a deployed agent has no browser. The whole point of pressing
"deploy" is that the workflow then runs from an API call at three in the
morning with nobody watching. Behaviour that lived in a React component could
not be invoked that way.

The third is that a definition is a record. It is saved, versioned, exported,
and read later by somebody reconstructing why a particular applicant was
declined. A definition that is only meaningful in combination with a specific
build of the frontend is not a record of anything.

---

## 2. The node registry

`packages/gravai_workflow/src/gravai_workflow/registry.py` declares what node
types exist. There are **31** in this build: 17 written out in `_CORE`, and 14
derived from the agent catalog.

A `NodeSpec` is the whole contract for one type — its `inputs`, its `outputs`,
its `config` fields, and four flags that the rest of the system reads:
`uses_llm`, `deterministic`, `branching` and `caveat`. Three surfaces consume
that one declaration: the canvas renders the node library and its configuration
panel from it, `WorkflowGraph.validate` checks a drawn graph against it, and
`engine.run_workflow` dispatches on it.

The fourteen agent nodes are **derived, not transcribed**. `_agent_nodes()`
walks `AGENT_CATALOG`, skips anything not in `gravai_runner.RUNNABLE` — the
catalog is allowed to list an agent the runner cannot yet assemble inputs for,
but the canvas is not allowed to offer it — and takes each node's output ports
straight off the agent's own Pydantic output model. Writing those ports out by
hand would guarantee a day on which the canvas offers a field the agent stopped
returning.

### Adding a node type

Two things, and genuinely nothing else:

1. A `NodeSpec` in `_CORE` in `registry.py`.
2. An entry in the `EXECUTORS` dictionary at the bottom of
   `packages/gravai_workflow/src/gravai_workflow/executors.py`, keyed by the
   same type string. An executor is
   `async def (node: NodeInstance, ctx: ExecutionContext) -> NodeOutcome`.

You do not touch the engine, the validator, or the frontend. The canvas will
show the new node in its family the next time it fetches the library, with its
configuration panel built from the `ConfigField` list, and the engine will
dispatch to it because it dispatches by table lookup rather than by a chain of
conditionals.

`validate_registry(EXECUTORS)` asserts the two sides match in both directions,
and it is worth understanding why it checks both. A node in the library with no
executor is a box that pretends to run — a demonstration feature, which is the
specific thing this product must not contain. An executor with no library entry
is dead code that nobody can reach. `registry.py` currently reports no problems
in either direction.

---

## 3. The shared workflow state

`packages/gravai_workflow/src/gravai_workflow/state.py`. One `WorkflowState`
per run, and every node reads from it and writes to it.

**Nodes do not pipe their output into each other.** This is the design decision
most worth understanding, because piping is what every diagram of a workflow
suggests and it falls over as soon as a workflow is more than a line. Node D
needs something node A found; node B has since summarised it; the edge between
C and D carries neither. You then either thread every value through every
intermediate node, or you invent a side channel — and the side channel is the
shared state, arrived at by a worse route.

So the edges say **what runs when**, not what is passed. The consequences:

- **A fact is written once and named.** `facts["monthly_income"]` means the same
  thing to every node downstream, whoever put it there. `set_fact` warns when a
  second node changes a fact another node established; a collision is a warning
  rather than an error because two nodes legitimately find the same thing, but
  silence is not on offer — a fact changing under a later node is precisely what
  makes a workflow impossible to debug.
- **Raw output is kept apart from facts.** `state.outputs[node_id]` is what a
  node returned verbatim, for the trace and for explicit `{{nodes.<id>.<field>}}`
  references. `state.facts` is what the workflow has decided is true. Conflating
  them is how a summary ends up quoted as a measurement.

A node moves an output into the facts deliberately, through the `publish_facts`
configuration field that most node types carry. That is why the underwriting
seed publishes `band` and `probability_30dpd_6m` off the risk node: the output
mapping four nodes later reads them by name and never has to know which node
produced them, so reordering or renaming the scoring stage does not break the
answer.

`state.resolution_scope()` is what expressions may address:
`{"workflow": <the whole state>, "nodes": <raw outputs by node id>, **facts}`.

---

## 4. The context compiler

`context_compiler`, executed by `_context_compiler` in `executors.py`. It sits
between two stages and decides what the next one needs to know.

Its `use_model` setting is **off by default, and should usually stay off**.
Selecting named facts, counting them, and carrying them forward is ordinary
data work: code does it exactly, instantly, and for nothing. A language model
does it approximately, in a second or two, for money — and a call placed
between every pair of nodes is the usual way a workflow becomes slow and
expensive without becoming better. Turn it on where a stage genuinely needs
prose compressed, which is a real need and a specific one.

With the model off, the node still does the useful part: `keep_facts` narrows
what is carried, a fact named there that nothing has set raises a warning
naming it, and `recommended_next_action` is passed forward. The `detail` it
returns reports how many facts were dropped, so a compiler that is quietly
carrying everything is visible in the trace rather than assumed.

---

## 5. Expressions

`packages/gravai_workflow/src/gravai_workflow/expressions.py`. Two entry points
and a deliberately small grammar.

- `render(text, scope)` substitutes every `{{ path }}` in a string — prompts,
  URLs, output mappings. Objects and lists are rendered as indented JSON,
  because the usual destination is a prompt and a Python `repr` full of single
  quotes reads badly to a model and to a person.
- `evaluate(expression, scope)` decides whether a condition is true.
- `lookup(path, scope)` resolves a dotted path, with `[n]` indexing, and on
  failure names the last segment that worked and lists what was available.
  "`bureau_scor` is not in workflow.facts" is a different message from
  "something, somewhere, is missing", and the difference is the whole cost of
  debugging a workflow.

The grammar, in full:

```
expr       := or_expr
or_expr    := and_expr ( 'or' and_expr )*
and_expr   := not_expr ( 'and' not_expr )*
not_expr   := 'not' not_expr | comparison
comparison := primary ( op primary )?
primary    := '(' expr ')' | literal | path
```

with `op` being `== != >= <= > <`, plus the word forms `in`, `contains` and
`empty` (`warnings empty` reads better in a form field than `len(warnings) == 0`).
Literals are quoted strings, numbers, `true`, `false`, `null`/`none`. Paths are
dotted names into the resolution scope.

**It is parsed, never evaluated.** There is no `eval` anywhere in this file. A
router condition is a piece of a lending decision and it arrives from a form
field in a browser, so it goes through a recursive-descent parser that can only
compare and combine. No expression in this system can call anything, import
anything, or reach outside the state it was handed. `eval` with a restricted
`__builtins__` is the tempting shortcut and it is a well-documented way to lose
a server.

Two details that matter in practice:

- `_compare` compares numerically when both sides are numbers and textually
  otherwise. A bureau score arriving as the string `"712"` from a JSON endpoint
  must still be greater than 700, or a router silently takes the wrong branch.
  Ordering comparisons on two non-numbers raise rather than guess.
- `check(expression)` parses without a scope, so that `WorkflowGraph.validate`
  can catch a malformed condition before a run. A name that does not resolve is
  not an error at that point — at validation time the state does not exist yet —
  but a syntax error is.

---

## 6. Validation, before anything runs

`WorkflowGraph.validate` in `graph.py` returns a list of `Problem`, each with a
severity, a message written to the person who drew the graph, and the node id to
highlight. `blocking` means severity `error`.

It runs **before** a run rather than during one. A graph that fails here has
never called a model, never billed anything, and never half-updated a state, and
the person who drew it is told which node is wrong while they are still looking
at it. Discovering a missing prompt on node seven after six nodes have run is
the outcome this exists to prevent.

What it checks: duplicate ids, unknown node types, edges pointing at nodes that
are not there, cycles (by Kahn's algorithm — `cycles()` reports whatever will
not peel), more than one `Input` node, unreachable nodes, required configuration
fields left empty, expression fields that do not parse, `{{ }}` references that
are not addressable, and, for branching nodes, that every outgoing edge names a
branch the node actually declares.

Two of its warnings are worth knowing because they catch real mistakes:

- A branching node that declares a branch with nothing connected to it — that
  path silently ends the run.
- A router whose last branch is conditional. End with a branch whose condition is
  `true`. An input matching none of the conditions otherwise stops at the router,
  and "the run ended and nobody was told" is the worst outcome a lending workflow
  can have. The `CREDIT_UNDERWRITING` seed in
  `packages/gravai_workflow/src/gravai_workflow/examples.py` ends its router this
  way, and `tests/test_workflow_examples.py` asserts that it still does.

`run_workflow` refuses to start when any problem is blocking, and returns a
`RunResult` with status `invalid` carrying the messages.

---

## 7. The execution engine

`packages/gravai_workflow/src/gravai_workflow/engine.py`.

**Layers and parallelism.** `WorkflowGraph.layers()` groups nodes so that
everything in a layer can run at once: a layer is the set of nodes whose
dependencies are all satisfied. A node runs when its dependencies are settled,
not when its turn comes — two branches of a fan-out are independent and run
concurrently, and a join waits because it has an edge from each. Running
strictly in topological order would serialise work that has no reason to be
serial. Concurrency is capped by `MAX_CONCURRENCY`, which is **8**: wide enough
for a real fan-out, low enough that a workflow cannot open fifty model
connections by accident.

**Branch pruning.** When a branching node returns a branch, `_prune_unchosen`
removes every outgoing edge except the chosen one from the live set. Anything
that then has no surviving incoming edge is recorded as `skipped`, not `failed`.
That distinction is not cosmetic: treating an untaken branch as a failure would
make every branching workflow report errors, and a status field that is always
red tells you nothing.

**Failure.** A node that raises does not take the run down — the executor call is
wrapped in `_run_node`, and the exception becomes that node's `error`.
`_prune_all` then discards every edge reachable from the failed node, so
everything downstream is recorded as skipped rather than attempted against a
state that never got its inputs. The run's status becomes `failed`.

**Halting.** `human_approval` is a genuine halt, not a marker. Its executor
returns `NodeOutcome(halt=True)`, the engine stops the loop, and the run ends
with status `awaiting_approval`. Nothing past that node executes. A node type
whose name promises a stop has to actually stop.

**Retries.** `_run_node` reads `retries` from the node's own config and re-runs
the executor while the attempt failed, recording `attempts` on the trace.
Be aware of the current state of this: **no node type declares a `retries`
configuration field**, so the engine honours the key but the canvas offers no
way to set it. Today it is reachable only by writing `"retries": n` into a
node's config by hand. Giving a node type a `ConfigField` for it is the change
that would make the feature real.

**The trace.** A `NodeTrace` per node, assembled as the run proceeds rather than
at the end, because a failed run is exactly when the trace matters. Each entry
carries status, duration, summary, the node's configuration, its outputs, its
error, the branch it chose, tokens and cost. `RunResult.as_dict()` is what the
TEST panel renders.

**Single-step replay.** `run_workflow(..., only_nodes={"risk"})` restricts
execution to named nodes, which is how the TEST screen re-runs one step.

---

## 8. Deterministic decisions outrank model opinions

The rule is: **rules decide, models reason.** It is enforced in one place,
`WorkflowState.add_decision` in `state.py`.

A `Decision` carries a `deterministic` flag. When a node tries to record a
decision under a name that already holds a deterministic one, and the new
decision is not itself deterministic, the write is refused: a warning is
appended naming the node that tried, and the existing decision stands. The
model does not quietly win.

This is why the `bre` node's `NodeSpec` carries the caveat "A model node cannot
overturn this; the engine refuses the write", and why the seed workflow's router
branches on `workflow.facts.policy_check` — the fact the rule engine wrote — and
not on the risk band a scorecard produced or on anything a language model said.
The ordering is deliberate: policy is applied, its determination is recorded as
deterministic, and only then does control flow read it.

`NodeSpec.deterministic` is the declaration and `Decision.deterministic` is the
enforcement. They are separate fields because the first is about a node type and
the second about a particular finding.

### What counts as policy having been met

The `bre` node reports `passed` only when at least one rule reached a verdict and
none of them stood in the way. Two cases are easy to get wrong, and both are
settled in `_bre` in `executors.py`:

- **A referral is not a pass.** The rule set's middle outcome means a person
  looks at the file. Counting only outright failures would read that as "nothing
  objected" and send the case down the automated branch — the one outcome the
  referral exists to prevent. `failed_rules` therefore carries referrals
  alongside failures, because both are things that stood in the way.
- **An abstention is not a pass either.** A rule reports `na` when the file did
  not carry what it needed, and a mapping expression that resolves to nothing is
  dropped rather than handed on as its own template text. If the mapping supplied
  none of the figures, every rule abstains and there is nothing to fail — so the
  obvious `not failed` would report a clean policy check on a file that was never
  checked. An evaluation in which no rule applied is recorded as `FAIL`, with the
  reason "no rule could be applied to the figures supplied".

`tests/test_workflow_examples.py` pins both, and pins which rules actually reach
a verdict for the seed's own inputs — otherwise a mapping that quietly stopped
resolving would leave every rule abstaining and every test still green.

---

## 9. Local setup

The repository is a `uv` workspace. Every recipe in the `justfile` has a plain
`uv run` equivalent, listed here directly.

### The API

```bash
uv sync                                                    # install the workspace into .venv
uv run alembic upgrade head                                # create the schema
uv run python scripts/seed.py                              # tenants, roles, users, rate card, demo applications
uv run uvicorn gravai_api.main:app --reload --port 8000
```

`http://localhost:8000/docs` is the OpenAPI UI; `http://localhost:8000/healthz`
is health. With no `SARVAM_API_KEY` set, the AI layer is forced into sandbox
mode by `build_sarvam` in
`packages/gravai_sarvam/src/gravai_sarvam/factory.py`, so nothing reaches a
vendor and nothing is billed.

### A development token

```bash
uv run python scripts/dev_token.py --tenant acme --role underwriter
```

`scripts/dev_token.py` mints an HS256 bearer token signed with `AUTH_DEV_SECRET`.
The refusal to issue one in production lives in `issue_dev_token` in
`packages/gravai_core/src/gravai_core/auth.py`, not in the script — it raises
`Forbidden` when `app_env` is `prod`, so no other caller can route around it
either. Production tokens come from the identity provider, never from a script
in the repository. The API accepts dev tokens while `OIDC_JWKS_URL` is unset.
Roles map to scopes through `ROLE_SCOPES` in
`packages/gravai_core/src/gravai_core/auth.py`; `underwriter` is the useful
default because it carries `agents:run`.

### The console

```bash
cd apps/web
npm install
npm run dev        # http://localhost:3000
```

Optionally, in `apps/web/.env.local`:

```
NEXT_PUBLIC_GRAVAI_API_BASE=http://localhost:8000
NEXT_PUBLIC_GRAVAI_ENV=local
```

Paste the token into **Console → Settings**. It is kept in `localStorage` and
attached to API calls directly from the browser; no Next.js server route proxies
it, so it is never written to a server log. The studio is at
`http://localhost:3000/console/studio`.

### Running the tests

```bash
uv run pytest
```

The suite forces sandbox mode and a throwaway SQLite database in
`tests/conftest.py`, so no test can reach a vendor and no test can touch a
developer's real database. Four files cover the studio specifically:
`tests/test_workflow_engine.py` (the registry, the validator, the shared state
and the engine), `tests/test_workflow_expressions.py` (the grammar),
`tests/test_workflow_examples.py` (both seeds validate cleanly and run to
completion down each branch), and `tests/test_studio_api.py` (one workflow
through its whole life over HTTP, including tenant isolation).

If `uv` is not on your path, the workspace interpreter works directly:

```bash
.venv/Scripts/python.exe -m pytest -q          # Windows
.venv/bin/python -m pytest -q                  # macOS and Linux
```

### The HTTP surface

`apps/api/src/gravai_api/routers/studio.py` serves the `/v1/studio` prefix that
`apps/web/src/lib/studio.ts` calls — `/nodes`, `/workflows`,
`/workflows/{id}/validate`, `/workflows/{id}/run`, `/workflows/{id}/compile`,
`/workflows/{id}/deploy` and `/runs` — and `gravai_api.main` includes it beside
the other routers. It follows the pattern in
`apps/api/src/gravai_api/routers/agents.py`: `DbSession`, `CurrentPrincipal` and
`Sarvam` from `apps/api/src/gravai_api/deps.py`, with `require_scope` on each
path, reading wider than running because an auditor who may read applications
may also read how the automation that touched them is built.

### What is not wired up yet

**Nothing serves the seed workflows.** `CREDIT_UNDERWRITING` and `TWO_STEP` in
`examples.py` validate and run, and `tests/test_workflow_examples.py` holds them
to that, but no endpoint offers them and the console has no control that asks for
one — so a new workflow still starts as an empty canvas. That is a missing
endpoint rather than a missing seed, and it is the reason the module docstring in
`examples.py` says what it does about how they are reached today.

Either way, the engine can be driven directly, which is also the quickest way to
try a change to a seed:

```python
from gravai_sarvam import build_sarvam
from gravai_workflow import from_dict, run_workflow
from gravai_workflow.examples import CREDIT_UNDERWRITING

async def nosleep(_: float) -> None:
    return None

graph = from_dict(CREDIT_UNDERWRITING)
assert not [p for p in graph.validate() if p.blocking]

sarvam = build_sarvam(polls_before_done=1, sleep=nosleep)
result = await run_workflow(
    graph,
    sarvam,
    # The intake's schema names nine fields, and the policy node maps all of
    # them. Supplying only the identifier is a valid call and is not a useful
    # one: every rule then abstains, and the run ends at the approval gate
    # rather than at a memorandum.
    inputs={
        "application_id": "18302",
        "loan_amount": 1000000,
        "tenure_months": 60,
        "interest_rate_pct": 11.0,
        "net_monthly_income": 85000,
        "existing_monthly_emi": 12000,
        "bureau_score": 712,
        "enquiries_3m": 3,
        "employment_vintage_months": 28,
    },
)
```

`polls_before_done=1` and a no-op `sleep` keep a sandbox run fast: the document
intelligence stage reads eight documents, and the default polling would make a
local run take minutes while proving nothing the document runner's own tests do
not already prove.

---

## 10. Where to start reading

In this order, and each file's own module docstring argues the design decision
it embodies:

| File | What it settles |
|---|---|
| `packages/gravai_workflow/src/gravai_workflow/registry.py` | What node types exist and what each promises |
| `.../graph.py` | The definition format, and everything that can be wrong with one |
| `.../state.py` | Why nodes share a state instead of piping output |
| `.../expressions.py` | The grammar, and why it is parsed rather than evaluated |
| `.../executors.py` | What each node actually does |
| `.../engine.py` | Layers, parallelism, pruning, halting, retries, the trace |
| `.../examples.py` | Two workflows to start from — seeds, not fixtures |
| `apps/api/src/gravai_api/routers/studio.py` | The life of a workflow over HTTP: drawn, checked, run, frozen, deployed |
| `apps/web/src/lib/studio.ts` | The same definition format, in TypeScript |
| `tests/test_workflow_engine.py` | What the engine is required to do, stated as sentences |
