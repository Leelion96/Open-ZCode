import {
  type ExpertWorkflowRunSnapshot,
  type WorkflowDefinition,
  type WorkflowGraph,
  type WorkflowGraphEdge,
  type WorkflowGraphNode,
  type WorkflowNodeStatus,
  type WorkflowPhaseDefinition,
} from "@zcode/contracts";
import { workflowDefinitionPhaseMap } from "../definition.js";
import { phaseNodeId } from "./ids.js";

export function buildPhasePrompt(
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
): string {
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  const architectureGraphContract =
    definition.seedGraphFromArtifact !== undefined
      ? [
          "",
          "Architecture graph contract:",
          `Return a JSON object, either raw or fenced as \`\`\`json, so the workflow runtime can seed the ${definition.seedGraphFromArtifact.targetPhase} DAG:`,
          '{"nodes":[{"id":"implement_auth","title":"Implement auth","description":"small executable unit","dependsOn":["setup_config"],"collectionId":"implementation","prompt":"optional node-specific instructions"}],"edges":[{"from":"setup_config","to":"implement_auth"}],"collections":[{"collectionId":"implementation","title":"Implementation","nodeIds":["setup_config","implement_auth"],"explorable":false,"goal":"ship the feature","metric":"tests pass"}],"reasoning":"brief rationale"}',
          "Node ids must be unique, references must point to real node ids, and edges must not create cycles.",
        ]
      : [];
  return [
    `You are running the workflow phase: ${definition.phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    "Scheduling strategy:",
    `- Clarify max rounds: ${snapshot.strategy.clarify.maxRounds}, min rounds: ${snapshot.strategy.clarify.minRounds}, confidence threshold: ${snapshot.strategy.clarify.confidenceThreshold}`,
    `- Executor frontier target: ${snapshot.strategy.executor.frontierTarget}, max concurrent loops: ${snapshot.strategy.executor.maxConcurrentLoops}, max planner runs: ${snapshot.strategy.executor.maxPlannerRuns}`,
    `- React loop max rounds: ${snapshot.strategy.reactLoop.maxRounds}`,
    `- Final critic max iterations: ${snapshot.strategy.finalCritic.maxIterations}`,
    "",
    `Phase objective:\n${definition.description}`,
    "",
    previousArtifacts.length > 0
      ? `Previous artifacts available on disk:\n${previousArtifacts}`
      : "No previous artifacts yet.",
    ...architectureGraphContract,
    "",
    "Output a concise Markdown artifact for this phase. Preserve concrete file paths, commands, risks, and next actions. If this phase executes code, make the edits and run focused validation when practical.",
  ].join("\n");
}

export function buildScheduledNodePrompt(
  snapshot: ExpertWorkflowRunSnapshot,
  definition: WorkflowPhaseDefinition,
  node: WorkflowGraphNode,
): string {
  if (node.phase === definition.phase && node.kind === "phase") {
    return buildPhasePrompt(snapshot, definition);
  }
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  return [
    `You are running a workflow node inside phase: ${definition.phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    `Node: ${node.title}`,
    `Node id: ${node.id}`,
    node.description ? `Node objective:\n${node.description}` : undefined,
    node.prompt ? `Node prompt:\n${node.prompt}` : undefined,
    "",
    "Scheduling constraints:",
    `- Max concurrent loops: ${snapshot.strategy.executor.maxConcurrentLoops}`,
    `- React loop max rounds: ${snapshot.strategy.reactLoop.maxRounds}`,
    "",
    previousArtifacts.length > 0
      ? `Previous artifacts available on disk:\n${previousArtifacts}`
      : "No previous artifacts yet.",
    "",
    "Execute only this node's scope. Return a concise Markdown artifact with changes, validation, and residual risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function buildScheduledPhaseSummary(
  snapshot: ExpertWorkflowRunSnapshot,
  phase: string,
): string {
  const activities = snapshot.activities.filter((activity) => activity.phase === phase);
  const activityLines = activities.map(
    (activity) =>
      `- ${activity.nodeId ?? activity.activityId}: ${activity.status}${activity.artifactPath ? ` (${activity.artifactPath})` : ""}${activity.error ? ` error=${activity.error}` : ""}`,
  );
  const nodeLines = snapshot.graph.nodes
    .filter((node) => node.phase === phase || node.kind === "task")
    .map(
      (node) =>
        `- ${node.id}: ${node.status}${node.attempts ? ` attempts=${node.attempts}` : ""}${node.error ? ` error=${node.error}` : ""}`,
    );
  return [
    `# ${phase} Scheduler Summary`,
    "",
    `Run: ${snapshot.runId}`,
    `Status: ${snapshot.status}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "## Nodes",
    "",
    ...(nodeLines.length > 0 ? nodeLines : ["- No scheduled nodes."]),
    "",
    "## Activities",
    "",
    ...(activityLines.length > 0 ? activityLines : ["- No activities."]),
    "",
  ].join("\n");
}

export function buildReport(snapshot: ExpertWorkflowRunSnapshot): string {
  const phaseLines = snapshot.phases.map(
    (phase) =>
      `- ${phase.phase}: ${phase.status}${phase.artifactPath ? ` (${phase.artifactPath})` : ""}`,
  );
  return [
    `# Workflow Report`,
    "",
    `Run: ${snapshot.runId}`,
    `Task: ${snapshot.task}`,
    `Status: ${snapshot.status}`,
    `Directory: ${snapshot.cwd}`,
    `Created: ${snapshot.createdAt}`,
    `Updated: ${snapshot.updatedAt}`,
    "",
    "## Phases",
    "",
    ...phaseLines,
    "",
    "## Activities",
    "",
    ...snapshot.activities.map(
      (activity) =>
        `- ${activity.phase}: ${activity.status} (${activity.activityId})${activity.sessionId ? ` session=${activity.sessionId}` : ""}${activity.turnId ? ` turn=${activity.turnId}` : ""}`,
    ),
    "",
    "## Artifacts",
    "",
    ...snapshot.artifacts.map((artifact) => `- ${artifact.label}: ${artifact.path}`),
    "",
  ].join("\n");
}

export function createPhaseGraph(definition: WorkflowDefinition): WorkflowGraph {
  const phaseDefinitions = workflowDefinitionPhaseMap(definition);
  const nodes: WorkflowGraphNode[] = definition.phaseOrder.map((phase) => {
    const phaseDefinition = phaseDefinitions.get(phase);
    if (!phaseDefinition) {
      throw new Error(`${definition.title} definition is missing phase: ${phase}`);
    }
    return {
      dependsOn: [],
      description: phaseDefinition.description,
      id: phaseNodeId(phaseDefinition.phase),
      kind: "phase",
      phase: phaseDefinition.phase,
      status: "pending",
      title: phaseDefinition.title,
    };
  });
  const edges: WorkflowGraphEdge[] = [];
  for (let index = 1; index < definition.phaseOrder.length; index++) {
    const previous = definition.phaseOrder[index - 1]!;
    const current = definition.phaseOrder[index]!;
    edges.push({
      from: phaseNodeId(previous),
      to: phaseNodeId(current),
    });
    const node = nodes[index]!;
    node.dependsOn = [phaseNodeId(previous)];
  }
  return { collections: [], edges, nodes };
}

export function updateGraphNodeStatus(
  graph: WorkflowGraph,
  phase: string,
  status: WorkflowNodeStatus | undefined,
): WorkflowGraph {
  if (!status) return graph;
  const targetNodeId = phaseNodeId(phase);
  return {
    collections: graph.collections,
    edges: graph.edges,
    nodes: graph.nodes.map((node) =>
      node.id === targetNodeId && node.kind === "phase"
        ? {
            ...node,
            status,
          }
        : node,
    ),
  };
}
