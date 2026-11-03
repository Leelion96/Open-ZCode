// Genuine recursion with a callback parameter: `walkTree` passes its own `visit` on to the
// re-entrant call, so the inner activation has the SAME bindings as the outer one. That is
// recursion: one `loop recursive` region, the callback inlined once inside it, and a `recur`
// jump at the re-entrant call.
interface Tree {
  name: string;
  children: Tree[];
}
async function walkTree(node: Tree, visit: (n: Tree) => Promise<string>): Promise<void> {
  await visit(node);
  for (const child of node.children) await walkTree(child, visit);
}
const root: Tree = { name: "r", children: [] };
await walkTree(root, async (n) => agent(`v-${n.name}`).ask<string>(`visit ${n.name}`));
return "done";
