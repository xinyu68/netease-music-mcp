#!/usr/bin/env node
import { loadConfig } from './config.mjs';
import { createRuntime } from './runtime.mjs';
import { createMcpServer } from './mcp-server.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
let runtime,
  server,
  closing = false;
async function close(code = 0) {
  if (closing) return;
  closing = true;
  const timer = setTimeout(() => process.exit(code), 5000);
  timer.unref();
  try {
    await runtime?.close();
    await server?.close();
  } finally {
    clearTimeout(timer);
    process.exit(code);
  }
}
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
process.stdin.on('end', () => close());
try {
  runtime = createRuntime(await loadConfig());
  server = createMcpServer(runtime);
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write(
    'NetEase MCP startup failed. Run npm run doctor to inspect configuration and dependencies.\n'
  );
  await close(1);
}
