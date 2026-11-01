import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, ws: false, watch: null },
  appType: "custom",
});
try {
  const { z } = await server.ssrLoadModule("zod");
  const { toolSchemas, toolDescriptions, toolRouting } =
    await server.ssrLoadModule("/src/tool-contract.ts");
  const tools = Object.entries(toolDescriptions).map(([name, description]) => {
    const inputSchema = z.toJSONSchema(
      name === "requests_list" ? toolRouting.requests : toolSchemas[name],
      { io: "input" },
    );
    delete inputSchema.$schema;
    const targets = inputSchema.properties ? [inputSchema] : inputSchema.anyOf;
    if (
      !targets?.every((target) => target.type === "object" && target.properties)
    )
      throw Error(`Tool ${name} needs an object input.`);
    const envelopes = [toolRouting.caller];
    if (toolRouting.windows.includes(name)) envelopes.push(toolRouting.window);
    if (toolRouting.destinations.includes(name))
      envelopes.push(toolRouting.destination);
    if (toolRouting.documents.includes(name))
      envelopes.push(toolRouting.document);
    for (const target of targets)
      for (const envelope of envelopes)
        Object.assign(
          target.properties,
          z.toJSONSchema(envelope, { io: "input" }).properties,
        );
    inputSchema.type = "object";
    inputSchema.properties = Object.assign(
      {},
      ...targets.map((target) => target.properties),
    );
    return { name, description, inputSchema };
  });
  const generated =
    "[\n" +
    tools.map((tool) => "  " + JSON.stringify(tool)).join(",\n") +
    "\n]\n";
  const destination = new URL(
    "../crates/inknb-core/src/tool-catalog.json",
    import.meta.url,
  );
  if (process.argv.includes("--check")) {
    if ((await readFile(destination, "utf8")) !== generated)
      throw Error("The agent catalog is stale. Run npm run agent:generate.");
  } else await writeFile(destination, generated);
  process.stdout.write(`Agent contract: ${tools.length} tool schemas.\n`);
} finally {
  await server.close();
}
