// How big a server's tool definitions are, and which of them the agent gets. The definitions
// go to the model on every turn, so this is the saved evidence for what the example's filter
// holds back. A write tool is one its server marks readOnlyHint false; a tool with no
// annotation isn't called one.

export interface ToolGroup { count: number; bytes: number; names: string[] }

export interface DefinitionSizes {
  measure: string;
  listed: ToolGroup;
  offered: ToolGroup;
  writeHeldBack: ToolGroup;
  writeOffered: ToolGroup;
  otherHeldBack: ToolGroup;
}

interface Definition { name: string; annotations?: { readOnlyHint?: boolean } }

export const SIZE_MEASURE = "UTF-8 bytes of each tool's JSON, as tools/list returned it";

function group(tools: readonly Definition[]): ToolGroup {
  const bytes = tools.reduce((sum, tool) => sum + Buffer.byteLength(JSON.stringify(tool)), 0);
  return { count: tools.length, bytes, names: tools.map((tool) => tool.name).sort() };
}

export function definitionSizes(tools: readonly Definition[], offeredNames: readonly string[]): DefinitionSizes {
  const isOffered = (tool: Definition) => offeredNames.includes(tool.name);
  const isWrite = (tool: Definition) => tool.annotations?.readOnlyHint === false;
  return {
    measure: SIZE_MEASURE,
    listed: group(tools),
    offered: group(tools.filter(isOffered)),
    writeHeldBack: group(tools.filter((tool) => isWrite(tool) && !isOffered(tool))),
    writeOffered: group(tools.filter((tool) => isWrite(tool) && isOffered(tool))),
    otherHeldBack: group(tools.filter((tool) => !isWrite(tool) && !isOffered(tool))),
  };
}
