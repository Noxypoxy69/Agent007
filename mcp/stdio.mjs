#!/usr/bin/env node
// Local stdio transport, for Claude Code / Cursor on the same machine.
// ChatGPT (hosted) cannot use this — it needs the HTTP endpoint at /mcp.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './tools.mjs';

const server = buildMcpServer();
await server.connect(new StdioServerTransport());
