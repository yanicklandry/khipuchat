import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { Message, Tool } from 'ollama'
import { initDb, upsertChat, insertMessage } from '../src/db'
import { TOOL_DEFINITIONS, dispatchTool } from '../src/tool-registry'
import {
  resolveOllamaConfig,
  toOllamaTools,
  runAskLoop,
  classifyOllamaError,
  type AskClient,
  type AskChatResult,
} from '../src/ask'

// ── Mock Ollama client ────────────────────────────────────────────────────────

interface ChatCall { model: string; messages: Message[]; tools: Tool[] }

class MockClient implements AskClient {
  public calls: ChatCall[] = []
  private index = 0
  /** If loopForever is set, always returns that tool-call response. */
  constructor(private responses: AskChatResult[], private loopForever?: AskChatResult) {}
  async chat(request: { model: string; messages: Message[]; tools: Tool[] }): Promise<AskChatResult> {
    this.calls.push({ model: request.model, messages: request.messages.map((m) => ({ ...m })), tools: request.tools })
    if (this.loopForever) return this.loopForever
    const res = this.responses[this.index]
    this.index += 1
    return res
  }
}

function toolCall(name: string, args: Record<string, unknown>): AskChatResult {
  return { message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] } }
}

function finalAnswer(content: string): AskChatResult {
  return { message: { role: 'assistant', content } }
}

function seedDb(): void {
  initDb(':memory:')
  const chat = upsertChat({ external_id: 'c1', account: 'default', name: 'Alice', type: 'user', username: null, platform: 'telegram' })
  insertMessage({ external_id: 'm1', chat_id: chat, sender_id: '1', sender_name: 'Alice', text: 'hi', type: 'text', timestamp: 1700000000, is_sender: 0, reply_to_external_id: null, platform: 'telegram' })
}

// ── resolveOllamaConfig ───────────────────────────────────────────────────────

describe('resolveOllamaConfig', () => {
  const saved = { host: process.env['OLLAMA_HOST'], model: process.env['OLLAMA_MODEL'] }
  afterEach(() => {
    if (saved.host === undefined) delete process.env['OLLAMA_HOST']; else process.env['OLLAMA_HOST'] = saved.host
    if (saved.model === undefined) delete process.env['OLLAMA_MODEL']; else process.env['OLLAMA_MODEL'] = saved.model
  })

  it('returns documented defaults when env is unset', () => {
    delete process.env['OLLAMA_HOST']
    delete process.env['OLLAMA_MODEL']
    expect(resolveOllamaConfig()).toEqual({ host: 'http://127.0.0.1:11434', model: 'qwen2.5' })
  })

  it('returns overrides when env is set', () => {
    process.env['OLLAMA_HOST'] = 'http://ollama.local:9999'
    process.env['OLLAMA_MODEL'] = 'llama3.1'
    expect(resolveOllamaConfig()).toEqual({ host: 'http://ollama.local:9999', model: 'llama3.1' })
  })
})

// ── toOllamaTools ─────────────────────────────────────────────────────────────

describe('toOllamaTools', () => {
  it('maps every registry definition to a function tool preserving names and schemas', () => {
    const tools = toOllamaTools()
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length)
    tools.forEach((tool, i) => {
      const def = TOOL_DEFINITIONS[i]
      expect(tool.type).toBe('function')
      expect(tool.function.name).toBe(def.name)
      expect(tool.function.description).toBe(def.description)
      expect(tool.function.parameters).toBe(def.inputSchema)
    })
  })
})

// ── dispatchTool unknown ──────────────────────────────────────────────────────

describe('dispatchTool unknown tool', () => {
  it('throws an unknown-tool error naming the tool', async () => {
    seedDb()
    await expect(dispatchTool('bogus_tool', {})).rejects.toThrow('Unknown tool: bogus_tool')
  })
})

// ── runAskLoop ────────────────────────────────────────────────────────────────

describe('runAskLoop', () => {
  beforeEach(() => seedDb())

  it('dispatches one tool call, appends a tool message, and returns the final content', async () => {
    const mock = new MockClient([toolCall('list_chats', {}), finalAnswer('Here is your answer.')])
    const result = await runAskLoop(mock, 'qwen2.5', 'who did I talk to?')
    expect(result).toBe('Here is your answer.')
    expect(mock.calls).toHaveLength(2)
    // The second chat call must have received a tool-role message with the dispatched result.
    const secondCallMessages = mock.calls[1].messages
    const toolMsg = secondCallMessages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.tool_name).toBe('list_chats')
    expect(toolMsg!.content).toContain('Alice')
  })

  it('stops at the iteration cap when the model loops forever and returns a best-available answer', async () => {
    const mock = new MockClient([], toolCall('list_chats', {}))
    const result = await runAskLoop(mock, 'qwen2.5', 'loop please')
    expect(typeof result).toBe('string')
    expect(result).toMatch(/no final answer/i)
    // Bounded: capped, not infinite.
    expect(mock.calls.length).toBeGreaterThan(1)
    expect(mock.calls.length).toBeLessThanOrEqual(8)
  })

  it('serializes a dispatch failure back to the model and continues the loop', async () => {
    const mock = new MockClient([toolCall('nonexistent_tool', {}), finalAnswer('Recovered.')])
    const result = await runAskLoop(mock, 'qwen2.5', 'trigger a bad tool')
    expect(result).toBe('Recovered.')
    const toolMsg = mock.calls[1].messages.find((m) => m.role === 'tool')
    expect(toolMsg).toBeDefined()
    expect(toolMsg!.content).toContain('Unknown tool: nonexistent_tool')
  })

  it('returns immediately when the first response has no tool calls', async () => {
    const mock = new MockClient([finalAnswer('Direct answer.')])
    const result = await runAskLoop(mock, 'qwen2.5', 'simple')
    expect(result).toBe('Direct answer.')
    expect(mock.calls).toHaveLength(1)
  })
})

// ── classifyOllamaError ───────────────────────────────────────────────────────

describe('classifyOllamaError', () => {
  const host = 'http://127.0.0.1:11434'
  const model = 'qwen2.5'

  it('maps a connection failure to an Ollama + host message', () => {
    const msg = classifyOllamaError(new Error('fetch failed: ECONNREFUSED 127.0.0.1:11434'), host, model)
    expect(msg).toContain('Ollama')
    expect(msg).toContain(host)
  })

  it('maps a missing-model error to a model + pull message', () => {
    const msg = classifyOllamaError(new Error('model "qwen2.5" not found, try pulling it first'), host, model)
    expect(msg).toContain(model)
    expect(msg.toLowerCase()).toContain('pull')
  })
})
