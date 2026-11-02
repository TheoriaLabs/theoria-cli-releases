import { createInterface } from 'node:readline';

/**
 * An MCP server with no tools, for a server Theoria manages that cannot run in this session (not installed, no
 * Mathlib): `/mcp` then shows it connected with 0 tools rather than failed, and its instructions say why. Speaks
 * newline-delimited JSON-RPC on stdin and stdout, the MCP stdio transport.
 */
export function serveUnavailable(name: string, reason: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<void> {
  const send = (message: unknown) => output.write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input });
  lines.on('line', line => {
    let message: { id?: string | number; method?: string; params?: { protocolVersion?: string } };
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined || !message.method) return;
    const reply = (result: unknown) => send({ jsonrpc: '2.0', id: message.id, result });
    switch (message.method) {
      case 'initialize':
        return reply({
          protocolVersion: message.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name, version: '0' },
          instructions: `Unavailable: ${reason}`,
        });
      case 'tools/list': return reply({ tools: [] });
      case 'ping': return reply({});
      default: return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${name} is unavailable: ${reason}` } });
    }
  });
  return new Promise(resolve => lines.on('close', resolve));
}
