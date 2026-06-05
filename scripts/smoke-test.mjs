#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const server = require("../bin/apple-contacts-mcp.cjs");

async function main() {
  const init = await server.handleRpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05" },
  });
  console.log(JSON.stringify(init.result.serverInfo));

  const tools = await server.handleRpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  console.log(`tools=${tools.result.tools.map((tool) => tool.name).join(",")}`);

  const dryRun = await server.callTool("test_roundtrip", { confirm: false });
  console.log(JSON.stringify(dryRun));

  if (process.env.APPLE_CONTACTS_MCP_LIVE_TEST === "1") {
    const live = await server.callTool("test_roundtrip", { confirm: true });
    console.log(JSON.stringify(live));
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});

