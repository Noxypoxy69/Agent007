#!/usr/bin/env node
/**
 * Local stdio transport, for Claude Code / Cursor on the same machine.
 *
 * ChatGPT (hosted) cannot use this — it needs the HTTP endpoint at /mcp.
 *
 * Backed by the LOCAL collector, not a database: this is the proof that the
 * seven tools return something useful, runnable before a Supabase project, a
 * Worker or a reader token exist. Nothing here opens a socket or leaves the
 * machine.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './tools.mjs';
import { createLocalStore } from '../src/localStore.mjs';

const server = buildMcpServer(createLocalStore());
await server.connect(new StdioServerTransport());
