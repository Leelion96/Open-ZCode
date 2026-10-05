import type {
  WorkflowGraphCollection,
  WorkflowGraphNode,
  WorkflowRunSnapshot,
} from "@zcode/contracts";
import { collectionNodeIdsForGraph, nodeById } from "./graph.js";

export function buildDefaultNodePrompt(
  snapshot: WorkflowRunSnapshot,
  node: WorkflowGraphNode,
  phase: string,
): string {
  const previousArtifacts = snapshot.artifacts
    .map((artifact) => `- ${artifact.label}: ${artifact.path}`)
    .join("\n");
  return [
    `You are running a workflow node for phase: ${phase}.`,
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
    previousArtifacts.length > 0
      ? `Previous artifacts available on disk:\n${previousArtifacts}`
      : "No previous artifacts yet.",
    "",
    "Execute only this node's scope. Return a concise Markdown artifact with changes, validation, and residual risk.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function buildDefaultPlannerPrompt(
  snapshot: WorkflowRunSnapshot,
  collection: WorkflowGraphCollection,
  phase: string,
): string {
  const collectionNodes = collectionNodeIdsForGraph(collection, snapshot.graph)
    .map((nodeId) => nodeById(snapshot.graph, nodeId))
    .filter((node): node is WorkflowGraphNode => node !== undefined)
    .map(
      (node) =>
        `- ${node.id} [${node.status}]: ${node.title}${node.description ? ` - ${node.description}` : ""}`,
    )
    .join("\n");
  return [
    `You are running a workflow exploration planner for phase: ${phase}.`,
    `Workflow run: ${snapshot.runId}`,
    `Working directory: ${snapshot.cwd}`,
    "",
    `User task:\n${snapshot.task}`,
    "",
    `Collection: ${collection.title ?? collection.collectionId}`,
    `Collection id: ${collection.collectionId}`,
    collection.goal ? `Goal:\n${collection.goal}` : undefined,
    collection.metric ? `Metric:\n${collection.metric}` : undefined,
    "",
    collectionNodes.length > 0
      ? `Existing collection nodes:\n${collectionNodes}`
      : "No existing collection nodes.",
    "",
    "Return only JSON matching this shape:",
    '{"nodes":[{"id":"string","title":"string","description":"string","dependsOn":["node-id"],"prompt":"string"}],"edges":[{"from":"node-id","to":"node-id"}],"collectionNodeIds":["node-id"],"exhausted":false,"reasoning":"string"}',
    "Use unique node ids, avoid cycles, and set exhausted=true only when no useful expansion remains.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function safeArtifactName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100) || "node";
}
