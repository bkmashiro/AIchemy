#!/usr/bin/env node
/**
 * mcp/index.ts — Alchemy MCP server entry point.
 *
 * Standalone process communicating via stdio transport.
 * Wraps the Alchemy REST API so AI agents can manage GPU tasks natively.
 *
 * Env vars:
 *   ALCHEMY_SERVER_URL — base URL (default http://localhost:3002)
 *   ALCHEMY_TOKEN      — auth token
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";

const server = new McpServer({
  name: "alchemy",
  version: "2.0.0",
}, {
  capabilities: { tools: {} },
});

registerTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Alchemy MCP server fatal: ${err}\n`);
  process.exit(1);
});
