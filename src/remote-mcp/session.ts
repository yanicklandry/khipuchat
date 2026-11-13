import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js'
import { TOOL_DEFINITIONS, dispatchTool, toToolContent } from '../tool-registry'
import type { RemoteMcpAudit } from './audit'
import type { RemoteMcpClient } from './config'

// Per-request MCP server scoped to one authenticated client (Req 4.3, 4.4, 4.7,
// 5.2, 5.4, 6.1). Authentication already happened in the HTTP layer, so there is
// no `_meta` auth here. Only registry tools (all read-only) can run (5.2), and a
// thrown tool error never reaches the client beyond a generic message (5.4).

export function createRemoteMcpServer(client: RemoteMcpClient, audit: RemoteMcpAudit): Server {
  const server = new Server({ name: 'khipuchat', version: '1.0.0' }, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.filter((t) => client.tools.has(t.name)),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params
    const started = performance.now()
    const elapsed = (): number => performance.now() - started

    if (!client.tools.has(name)) {
      audit.record({ op: 'tools/call', client: client.name, tool: name, outcome: 'denied', ms: elapsed() })
      throw new McpError(ErrorCode.InvalidParams, 'Tool not available')
    }

    let content: ReturnType<typeof toToolContent>
    try {
      content = toToolContent(await dispatchTool(name, args ?? {}))
    } catch (err) {
      audit.record({ op: 'tools/call', client: client.name, tool: name, outcome: 'error', ms: elapsed() })
      // Only the error type is logged: tool error messages can echo argument values (Req 6.2).
      const message = err instanceof Error ? err.name : typeof err
      audit.record({ op: 'tool-error', client: client.name, tool: name, message })
      throw new McpError(ErrorCode.InternalError, 'Tool failed')
    }
    audit.record({ op: 'tools/call', client: client.name, tool: name, outcome: 'ok', ms: elapsed() })
    return content
  })

  return server
}
