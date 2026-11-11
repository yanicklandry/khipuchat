import * as path from 'path'
import { Ollama, type Message, type Tool } from 'ollama'
import { initDb } from './db'
import { TOOL_DEFINITIONS, dispatchTool } from './tool-registry'

// ── Configuration ───────────────────────────────────────────────────────────────

export interface OllamaConfig {
  host: string
  model: string
}

/** Resolve Ollama host/model from env. Does NOT import config.ts (it eagerly requires Telegram env). */
export function resolveOllamaConfig(): OllamaConfig {
  return {
    host: process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434',
    model: process.env['OLLAMA_MODEL'] ?? 'qwen2.5',
  }
}

// ── Tool + prompt mapping ────────────────────────────────────────────────────────

/** Map the shared registry definitions to the Ollama function-tool format. */
export function toOllamaTools(): Tool[] {
  return TOOL_DEFINITIONS.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as unknown as Tool['function']['parameters'],
    },
  }))
}

export function buildSystemPrompt(): string {
  return [
    'You are the KhipuChat archive assistant.',
    'The user asks natural-language questions about their personal message archive',
    '(chats and messages synced from Telegram, iMessage, Discord, Slack, WhatsApp, and more).',
    'Use the provided tools to look up chats and messages before answering — never invent data.',
    'Prefer discovering chats with list_chats/find_chat_by_name, then read or search messages.',
    'When you answer, cite the relevant chat name, sender, and timestamp where helpful.',
    'If the tools return nothing relevant, say clearly that you could not find an answer in the archive.',
    'Keep answers concise and grounded strictly in the tool results.',
  ].join(' ')
}

// ── Agent loop ────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 8
const MAX_TOOL_RESULT_CHARS = 8000

export type AskChatResult = { message: Message }

export interface AskClient {
  chat(request: { model: string; messages: Message[]; tools: Tool[] }): Promise<AskChatResult>
}

/** Serialize a tool result, bounding its length so large payloads (e.g. get_image base64) never flood context. */
function boundResult(result: unknown): string {
  const serialized = JSON.stringify(result) ?? 'null'
  if (serialized.length > MAX_TOOL_RESULT_CHARS) {
    return `${serialized.slice(0, MAX_TOOL_RESULT_CHARS)}…[truncated ${serialized.length - MAX_TOOL_RESULT_CHARS} chars]`
  }
  return serialized
}

/**
 * Run the bounded Ollama tool-call loop. Seeds system+user, and while the model returns tool calls,
 * dispatches each through dispatchTool and feeds the result back. Terminates on no-calls or the cap.
 */
export async function runAskLoop(client: AskClient, model: string, question: string): Promise<string> {
  const tools = toOllamaTools()
  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: question },
  ]
  let lastContent = ''
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const { message } = await client.chat({ model, messages, tools })
    if (message.content) lastContent = message.content
    const calls = message.tool_calls
    if (!calls || calls.length === 0) return message.content ?? ''
    messages.push(message)
    for (const call of calls) {
      const toolName = call.function.name
      let content: string
      try {
        const result = await dispatchTool(toolName, call.function.arguments as Record<string, unknown>)
        content = boundResult(result)
      } catch (err) {
        content = JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
      }
      messages.push({ role: 'tool', content, tool_name: toolName })
    }
  }
  return lastContent || 'No final answer was produced within the tool-call iteration limit.'
}

// ── Error classification ──────────────────────────────────────────────────────────

/** Turn a raw chat failure into a friendly message: unreachable host vs missing model. */
export function classifyOllamaError(err: unknown, host: string, model: string): string {
  const message = err instanceof Error ? err.message : String(err)
  const lower = message.toLowerCase()
  const isConnection =
    lower.includes('econnrefused') || lower.includes('fetch failed') || lower.includes('connect') ||
    lower.includes('enotfound') || lower.includes('econnreset') || lower.includes('network') ||
    lower.includes('timeout') || lower.includes('unable to connect')
  const isMissingModel =
    lower.includes('not found') || lower.includes('try pulling') || lower.includes('no such model') ||
    lower.includes('does not exist') || lower.includes('pull the model')
  if (isMissingModel && !isConnection) {
    return `Model "${model}" is not available on the Ollama server. Pull it first with: ollama pull ${model}`
  }
  return `Could not reach Ollama at ${host}. Make sure 'ollama serve' is running and OLLAMA_HOST is correct. (${message})`
}

// ── CLI entrypoint ────────────────────────────────────────────────────────────────

const ASK_USAGE = [
  'Usage: khipu ask "<question>"',
  '',
  'Ask a natural-language question about your archive using a local Ollama model.',
  '',
  'Environment:',
  '  OLLAMA_HOST   Ollama endpoint (default http://127.0.0.1:11434)',
  '  OLLAMA_MODEL  Model name (default qwen2.5)',
  '',
  'Example:',
  '  khipu ask "when did Tony last message me about the invoice?"',
].join('\n')

export async function main(argv: readonly string[]): Promise<number> {
  const question = argv[0]
  if (!question || question.trim() === '') {
    process.stdout.write(`${ASK_USAGE}\n`)
    return 0
  }
  const cfg = resolveOllamaConfig()
  initDb(path.join(__dirname, '..', 'khipuchat.db'))
  const client = new Ollama({ host: cfg.host })
  let answer: string
  try {
    answer = await runAskLoop(client, cfg.model, question)
  } catch (err) {
    process.stderr.write(`${classifyOllamaError(err, cfg.host, cfg.model)}\n`)
    return 1
  }
  process.stdout.write(`${answer}\n`)
  return 0
}

if (require.main === module) {
  void main(process.argv.slice(2)).then((code) => { process.exit(code) })
}
