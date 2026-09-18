import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolDefs, instructionsFor } from './toolDefs.mjs';

/**
 * THE SDK ADAPTER. The tools themselves live in toolDefs.mjs.
 *
 * They were split when the Cloudflare Worker needed the same surface:
 * StreamableHTTPServerTransport is written against node's IncomingMessage and
 * ServerResponse, and a Worker has Request and Response instead. Rather than
 * reimplement the tools for the edge -- which is how a hosted surface and a
 * local one begin answering differently about the same machine -- the
 * definitions moved somewhere neither transport owns.
 *
 * This file's job is now one thing: turn JSON Schema into the zod raw shape
 * registerTool wants. The conversion lives on THIS side on purpose. The SDK
 * validates arguments against the zod shape it is given, so a conversion bug
 * surfaces here as a rejected call during local development; putting the lossy
 * step on the Worker path would hide it on the deployment nobody can attach a
 * debugger to.
 *
 * Step 1 exposes no tool that mutates anything, assigns work, or reaches the
 * machine. Adding a write tool is a decision with its own threat model.
 */

/**
 * JSON Schema property -> zod, for the small vocabulary these tools use.
 *
 * Deliberately NOT a general converter. It handles string, boolean and number,
 * and throws on anything else rather than silently degrading to z.any() -- an
 * unvalidated argument reaching a tool is worse than a loud failure at startup,
 * and a converter that quietly accepts everything is indistinguishable from one
 * that works until the day it matters.
 */
function zodFor(prop, name) {
  const base = {
    string: () => z.string(),
    boolean: () => z.boolean(),
    number: () => z.number(),
  }[prop?.type];
  if (!base) {
    throw new TypeError(`toolDefs: unsupported input type "${prop?.type}" for "${name}"`);
  }
  const s = base();
  return prop.description ? s.describe(prop.description) : s;
}

/** JSON Schema object -> the raw shape registerTool expects. */
export function toZodShape(input) {
  const props = input?.properties ?? {};
  const required = new Set(input?.required ?? []);
  const shape = {};
  for (const [name, prop] of Object.entries(props)) {
    const s = zodFor(prop, name);
    shape[name] = required.has(name) ? s : s.optional();
  }
  return shape;
}

/**
 * @param {object} store  must provide listSessions() and getLanes();
 *                        listDelegations() is optional.
 *
 * REQUIRED, with no default, on purpose. A default would import
 * bridge/store.mjs -- and therefore `pg` -- into every consumer of this file,
 * including the Worker, where a node TCP driver cannot run at all.
 */
export function buildMcpServer(store) {
  const defs = toolDefs(store);                     // validates the store

  const server = new McpServer(
    { name: 'agentbridge', version: '0.1.0' },
    // Derived from the list this server is about to register, so the contract
    // and the capability cannot disagree. See instructionsFor in toolDefs.mjs.
    { capabilities: { tools: {} }, instructions: instructionsFor(defs) },
  );

  for (const def of defs) {
    server.registerTool(
      def.name,
      { title: def.title, description: def.description, inputSchema: toZodShape(def.input) },
      async (args) => def.run(args ?? {}),
    );
  }

  return server;
}
