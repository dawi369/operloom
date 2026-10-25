import { defineAgentPack } from "@operloom/agent-sdk/manifest";

export const polymancerPrompt = `<identity>
You are Polymancer, a careful analyst who helps people turn ideas about the world into dated Questions they can forecast, research and settle. You respect the user's judgment. You keep a record, not a trading desk.
</identity>

<voice>
- Plain and specific: short sentences, a date on every fact, probabilities as "60% · about 6 in 10".
- Always attribute a number: "your forecast", "my estimate" or "the market". Never blend them.
- Two-sided: after arguing a point, give the strongest case against it.
- Say "I don't know", "not enough evidence" and "no contract asks exactly this question" whenever they are true.
- Calm and neutral about action. Never say "you should buy".
</voice>

<interview>
Turn the idea into Questions, asking one thing per turn:
1. Hear the idea in the user's words. Ask what they expect and why.
2. Find what is missing: the subject, the measurable event or threshold, the deadline with a time zone, the geography or population, and what would show it happened.
3. After three turns without convergence, offer two concrete readings to pick from, or offer to save a draft.
4. Draft "Will [observable event] happen by [date, time zone], as reported by [source]?" with definitions, edge cases and a fallback source. Offer at most three Questions per idea.
5. When the user confirms the wording, call polymancer.question.save with the idea in their words, the wording, the criteria, an ISO deadline with a time zone, a topic and two or three short search phrases.
6. Before sharing any estimate, base rate or price, ask for their probability (optionally a range) and their strongest reason on each side, then call polymancer.forecast.commit. Changing the wording after a forecast means saving a new Question.
</interview>

<matching>
- When the user wants to find markets for a Question that has a forecast, call polymancer.match.find. Report each contract's level (exact, close or related) with its wording, deadline and source reasons.
- With no exact match, say "No contract asks exactly this question" and offer to save and watch it. That is a complete outcome.
- For a close match, offer to forecast the contract's version: call polymancer.question.adopt, then ask for a fresh forecast before anything else.
- Never treat a contract as the user's Question.
</matching>

<research>
- Once a forecast is committed, offer the brief: call polymancer.brief.create. It searches dated sources and never sees the user's forecast or any price.
- Present it as "my estimate": the range and point, the base rate, the strongest case for and against with sources and dates, and what would change it. Say "not enough evidence" when the brief says so.
</research>

<market>
- The price check is optional; saving and watching is always a complete outcome. Call polymancer.price.check only for an exact match and only after the forecast.
- Lead with the verdict (possible edge, no edge or not enough evidence), then the market after costs for the size, then the gap at the user's forecast and at my estimate, each labelled.
- "No edge" is a normal, useful result. Never propose a paper position after it.
- Call polymancer.position.open only when the user explicitly asks to put it to work on paper, with their maximum loss. Report the shares, the cost, and the result if it resolves Yes or No, marked as paper. polymancer.position.close closes it with their reason.
</market>

<watch>
- "Save and watch" is a complete outcome: call polymancer.question.watch. Polymancer then checks it every minute and alerts at most once a day, only for material changes.
- When an alert or a re-research comes up, explain what changed against the original reasoning and offer choices: keep, revise the forecast, close the paper position, or stop watching. Never act on them yourself.
- When an outcome is proposed, show the evidence and ask the user to confirm, correct or mark it unresolvable, then call polymancer.outcome.confirm. A contract's payout is evidence, not the answer.
- The user's Record scores their original forecast; revisions are scored separately.
</watch>

<grounding>
- The polymancer.questions runtime evidence lists the user's active Questions with their ids, stages and forecasts. Use those ids in tool calls.
- Holdings come only from the polymancer.portfolio evidence.
- Never invent Questions, forecasts, matches, prices or sources. When evidence is missing or stale, say so.
</grounding>

<boundaries>
- Paper only. Never claim to place real orders, move funds or access wallet credentials.
- Never offer sports markets. Never change a user's forecast or position on their behalf.
- Do not give financial advice; explain what the evidence implies and leave the decision to the user.
</boundaries>`;

const chatTool = (id: string, purpose: string) => ({
  id,
  invocation: "agent" as const,
  required: true,
  executionModes: ["dry_run" as const],
  modelVisibleDefault: true,
  purpose,
});
const workflow = (type: string, description: string) => ({
  type,
  status: "declared" as const,
  userInvocable: true,
  description,
});

export const polymancerPack = defineAgentPack({
  id: "polymancer",
  name: "Polymancer",
  description:
    "Turn an idea into a dated Question, commit your forecast, and find the Polymarket or Kalshi contract that really asks it. Paper only.",
  profile: "operator",
  version: "1.1.0",
  capabilityLevel: "single_agent_app",
  format: "xml",
  folderPath: "agent-packs/polymancer",
  codePath: "agent-packs/polymancer/index.ts",
  promptPath: "agent-packs/polymancer/prompt.xml",
  tools: [
    chatTool("polymancer.question.save", "Save a confirmed Question from the interview."),
    chatTool("polymancer.forecast.commit", "Record the user's own forecast for a Question."),
    chatTool("polymancer.match.find", "Find and judge contracts that ask a Question."),
    chatTool("polymancer.question.adopt", "Draft a Question on a close contract's own terms."),
    chatTool("polymancer.brief.create", "Research a forecasted Question into a cited brief."),
    chatTool("polymancer.price.check", "Check an exact contract's price after costs."),
    chatTool("polymancer.position.open", "Record a paper position the user asked for."),
    chatTool("polymancer.position.close", "Close a Question's open paper position."),
    chatTool("polymancer.question.watch", "Save a Question and watch it quietly."),
    chatTool("polymancer.outcome.confirm", "Record how a Question resolved."),
  ],
  workflows: [
    workflow("polymancer.question.save", "Save or edit a Question."),
    workflow("polymancer.forecast.commit", "Commit or revise your forecast."),
    workflow("polymancer.match.find", "Find Polymarket and Kalshi contracts for a Question."),
    workflow("polymancer.question.adopt", "Forecast a close contract's own version."),
    workflow("polymancer.brief.create", "Get a cited, two-sided brief for a Question."),
    workflow("polymancer.price.check", "See what the market thinks, after costs."),
    workflow("polymancer.position.open", "Put a Question to work on paper."),
    workflow("polymancer.position.close", "Close a paper position."),
    workflow("polymancer.question.watch", "Save and watch a Question."),
    workflow("polymancer.watch.tick", "Check watched Questions for material changes."),
    workflow("polymancer.outcome.confirm", "Confirm how a Question resolved."),
    workflow("polymancer.question.archive", "Archive a Question."),
    workflow("polymancer.copy.start", "Track a wallet and mirror its new trades on paper."),
    workflow("polymancer.copy.sync", "Mirror new tracked-wallet trades as paper fills."),
    workflow("polymancer.heartbeat", "Mark positions and record noop or material changes."),
  ],
  ui: {
    primarySurface: "workbench",
    inspectorSections: ["prompt", "history"],
    configurationMode: "code",
    welcome: {
      title: "Bring an idea",
      description:
        "Talk an idea through and it becomes a dated Question. Commit your forecast, then see which Polymarket or Kalshi contract really asks it.",
      starters: [
        {
          id: "idea",
          title: "I have an idea",
          description: "Turn a hunch into a Question you can forecast.",
          action: {
            kind: "message",
            prompt:
              "I have a hunch about something that might happen. Help me turn it into a question I can forecast.",
          },
        },
        {
          id: "questions",
          title: "My Questions",
          description: "Where each of your Questions stands.",
          action: {
            kind: "message",
            prompt: "Which Questions do I have, and where does each stand?",
          },
        },
      ],
    },
  },
  risk: {
    financialData: true,
    externalMutation: false,
    requiresSecrets: false,
    productionGate: "none",
  },
  connections: [],
  context: [
    {
      id: "questions",
      trust: "trusted",
      description: "The user's active Questions with their stages, forecasts and best match.",
      required: true,
      runtimeBinding: "polymancer.questions",
    },
    {
      id: "portfolio",
      trust: "trusted",
      description: "Paper cash, open paper positions with marks, exposure and PnL.",
      required: true,
      runtimeBinding: "polymancer.portfolio",
    },
  ],
  managedState: [
    {
      namespace: "polymancer",
      schemaVersion: 1,
      description:
        "Ideas, Questions, contract matches, briefs, price checks, paper positions and account, and the copy-trading experiment's records.",
      recordKinds: [
        "idea",
        "question",
        "match",
        "brief",
        "pricecheck",
        "position",
        "account",
        "copy_position",
        "copy_account",
        "budget",
        "wallet",
        "activity",
        "market",
        "heartbeat",
      ],
      views: [],
    },
  ],
  triggers: [
    {
      id: "watch",
      kind: "monitor",
      description: "Check watched Questions and open paper positions once a minute.",
      workflowType: "polymancer.watch.tick",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
    {
      id: "wallet-activity",
      kind: "monitor",
      description: "Mirror new tracked-wallet trades once a minute.",
      workflowType: "polymancer.copy.sync",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
    {
      id: "heartbeat",
      kind: "monitor",
      description: "Mark positions and record material moves once a minute.",
      workflowType: "polymancer.heartbeat",
      enabledByDefault: false,
      intervalSeconds: 60,
    },
  ],
  artifactRenderers: [
    { artifactKind: "polymancer.question", renderer: "table", title: "Question", version: 1 },
  ],
  healthChecks: [],
  evals: [],
  compatibility: { packApi: 2, minimumWorkbenchVersion: "2.0.0" },
  resourceLimits: {
    maxRunSeconds: 120,
    maxToolCallsPerRun: 1,
    maxConcurrentRuns: 1,
    maxArtifactBytes: 32768,
  },
  smokeScenarios: [{ id: "questions", prompt: "Which Questions do I have?" }],
  prompt: polymancerPrompt,
});
