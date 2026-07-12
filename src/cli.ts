#!/usr/bin/env node
/**
 * khipuchat CLI — call MCP tools from the terminal.
 *
 * Usage:
 *   npm run cli <tool> [query] [options]
 *
 * Examples:
 *   npm run cli semantic-search "find events tonight in asuncion"
 *   npm run cli search "pub crawl asuncion"
 *   npm run cli list-chats
 *   npm run cli find-chat "nomads"
 *   npm run cli messages 12345
 */

import path from 'path'
import { initDb } from './db'
import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
  parseTemporalFilters,
  handleGetImage,
} from './mcp'
import { listArchiveAccounts } from './query-handlers'
import { parseQueryFilters } from './cli-filters'
import { rebuildEmbeddings } from './index-embeddings'

// ── Pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Parse --account <name> from an args array.
 * Returns the account name and a new array with the flag and its value removed.
 * Mirrors the index-based pattern used by --min-similarity.
 */
export function parseAccountArg(args: readonly string[]): { account: string | undefined; rest: string[] } {
  const rest = [...args]
  const idx = rest.indexOf('--account')
  if (idx === -1) return { account: undefined, rest }
  const value = rest[idx + 1]
  // Remove the flag (and its value if present and not another flag)
  if (value !== undefined && !value.startsWith('--')) {
    rest.splice(idx, 2)
    return { account: value, rest }
  }
  // --account at end with no value: remove the flag only
  rest.splice(idx, 1)
  return { account: undefined, rest }
}

/**
 * Format the platform label for a row.
 * When the archive contains more than one distinct account (isMultiAccount),
 * append the account name to the platform so results are unambiguous.
 */
export function formatPlatformLabel(platform: string, account: string, isMultiAccount: boolean): string {
  return isMultiAccount ? `${platform}/${account}` : platform
}

/**
 * Parse --force from an args array.
 * Returns true if --force is present, false otherwise.
 */
export function parseForceArg(args: readonly string[]): boolean {
  return args.includes('--force')
}

/**
 * Returns the CLI usage/help text.
 * Exported for testing.
 */
export function getUsageText(): string {
  return `Usage: npm run cli <tool> [query]

Tools:
  semantic-search <query>     Semantic search across all messages
  semantic-contacts <query>   Find contacts by meaning
  search <query>              Keyword search across messages
  list-chats                  List all chats
  find-chat <name>            Find chats by name
  messages <chat_id>          List recent messages in a chat
  summary <chat_id>           Get chat summary
  get_image <message_id>      Retrieve a stored image: file path, availability, and OCR text
  index [--force]             Embed all messages/chats (incremental by default; --force clears and rebuilds from scratch)
`
}

// ── Script entry ──────────────────────────────────────────────────────────────

initDb(path.join(__dirname, '..', 'khipuchat.db'))

const [, , tool, ...rawRest] = process.argv

// Parse --min-similarity N from args (e.g. --min-similarity 0.6 or --min-similarity 60)
let minSimilarityArg: number | undefined
const minSimIdx = rawRest.indexOf('--min-similarity')
if (minSimIdx !== -1) {
  const raw = parseFloat(rawRest[minSimIdx + 1] ?? '')
  if (!isNaN(raw)) minSimilarityArg = raw > 1 ? raw / 100 : raw  // accept both 60 and 0.6
  rawRest.splice(minSimIdx, 2)
}

// Parse --account <name> from args
const { account: accountArg, rest } = parseAccountArg(rawRest)

const query = rest[0] ?? ''

function ts(t: number) {
  return new Date(t * 1000).toLocaleString()
}

async function main() {
  if (!tool) {
    console.log(getUsageText())
    process.exit(0)
  }

  // Determine whether the archive has more than one distinct account.
  // Used to decide whether to show the account label beside the platform.
  const archiveAccounts = listArchiveAccounts()
  const isMultiAccount = new Set(archiveAccounts.map(a => a.account)).size > 1

  switch (tool) {
    case 'semantic-search': {
      if (!query) { console.error('Usage: npm run cli semantic-search "your query"'); process.exit(1) }
      const temporalFilters = parseTemporalFilters(query)
      const hasTimeFilter = temporalFilters.after_timestamp !== undefined
      console.log(`\nSemantic search: "${query}"`)
      if (hasTimeFilter) {
        const afterDate = new Date(temporalFilters.after_timestamp! * 1000).toLocaleDateString()
        console.log(`  Searching messages since: ${afterDate}`)
      }
      if (minSimilarityArg !== undefined) {
        console.log(`  Min similarity: ${(minSimilarityArg * 100).toFixed(0)}%`)
      }
      console.log()
      // Temporal filters and default min_similarity are merged inside handleSemanticSearchMessages.
      // Pass explicit min_similarity only when the user provided --min-similarity.
      const result = await handleSemanticSearchMessages(query, {
        limit: 20,
        ...(minSimilarityArg !== undefined ? { min_similarity: minSimilarityArg } : {}),
        ...(accountArg !== undefined ? { account: accountArg } : {}),
      })
      if ('error' in result) { console.error(result.error); process.exit(1) }
      if (result.length === 0) { console.log('No results found.'); break }
      for (const r of result) {
        const platformLabel = formatPlatformLabel(r.platform, r.account ?? 'default', isMultiAccount)
        console.log(`[${ts(r.timestamp)}] ${r.chat_name} (${platformLabel})`)
        if (r.sender_name) console.log(`  ${r.sender_name}: ${r.text ?? ''}`)
        else console.log(`  ${r.text ?? ''}`)
        console.log(`  similarity: ${((1 - r.distance) * 100).toFixed(0)}%\n`)
      }
      break
    }

    case 'semantic-contacts': {
      if (!query) { console.error('Usage: npm run cli semantic-contacts "your query"'); process.exit(1) }
      console.log(`\nSemantic contact search: "${query}"\n`)
      const result = await handleSemanticFindContacts(query, {
        limit: 10,
        ...(accountArg !== undefined ? { account: accountArg } : {}),
      })
      if ('error' in result) { console.error(result.error); process.exit(1) }
      if (result.length === 0) { console.log('No contacts found.'); break }
      for (const r of result) {
        const platformLabel = formatPlatformLabel(r.platform, r.account ?? 'default', isMultiAccount)
        console.log(`${r.name} (${platformLabel}) — ${r.message_count} messages`)
        if (r.snippet) console.log(`  "${r.snippet.slice(0, 80)}"`)
        console.log()
      }
      break
    }

    case 'search': {
      const parseResult = parseQueryFilters(rawRest)
      if (!parseResult.ok) {
        console.error(parseResult.error)
        process.exit(1)
      }
      const { filters, rest: searchRest } = parseResult
      const searchQuery = searchRest[0] ?? ''
      if (!searchQuery) {
        console.error('Usage: khipu search <query> [--platform <p>] [--account <a>] [--since <date>] [--until <date>] [--type <t>] [--limit <n>]')
        process.exit(1)
      }
      console.log(`\nKeyword search: "${searchQuery}"\n`)
      const results = handleSearchMessages(searchQuery, filters)
      if (results.length === 0) { console.log('No results found.'); break }
      for (const r of results) {
        const platformLabel = formatPlatformLabel(r.platform, r.account, isMultiAccount)
        console.log(`[${ts(r.timestamp)}] Chat #${r.chat_id} (${platformLabel})`)
        if (r.sender_name) console.log(`  ${r.sender_name}: ${r.text}`)
        else console.log(`  ${r.text}`)
        console.log()
      }
      break
    }

    case 'list-chats': {
      const chats = handleListChats({ account: accountArg })
      for (const c of chats.slice(0, 30)) {
        const platformLabel = formatPlatformLabel(c.platform, c.account, isMultiAccount)
        console.log(`[${c.chat_id}] ${c.name} (${platformLabel}, ${c.type}, ${c.message_count} msgs)`)
      }
      if (chats.length > 30) console.log(`  … and ${chats.length - 30} more`)
      break
    }

    case 'find-chat': {
      if (!query) { console.error('Usage: npm run cli find-chat "name"'); process.exit(1) }
      const chats = handleFindChatByName(query, undefined, accountArg)
      if (chats.length === 0) { console.log('No chats found.'); break }
      for (const c of chats) {
        const platformLabel = formatPlatformLabel(c.platform, c.account, isMultiAccount)
        console.log(`[${c.chat_id}] ${c.name} (${platformLabel}, ${c.type}, ${c.message_count} msgs)`)
      }
      break
    }

    case 'messages': {
      const chatId = parseInt(query, 10)
      if (isNaN(chatId)) { console.error('Usage: npm run cli messages <chat_id>'); process.exit(1) }
      const { messages } = handleListMessages(chatId, { limit: 20 })
      for (const m of messages) {
        const dir = m.is_sender ? '→' : '←'
        console.log(`${dir} [${ts(m.timestamp)}] ${m.sender_name ?? 'you'}: ${m.text?.slice(0, 120)}`)
      }
      break
    }

    case 'summary': {
      const chatId = parseInt(query, 10)
      if (isNaN(chatId)) { console.error('Usage: npm run cli summary <chat_id>'); process.exit(1) }
      const s = handleGetChatSummary(chatId)
      console.log(`${s.name} (${s.platform}, ${s.type})`)
      console.log(`Messages: ${s.message_count}`)
      if (s.first_message_date) console.log(`First: ${ts(s.first_message_date)}`)
      if (s.last_message_date) console.log(`Last:  ${ts(s.last_message_date)}`)
      console.log('\nRecent messages:')
      for (const t of s.last_5_texts) console.log(`  "${t.slice(0, 100)}"`)
      break
    }

    case 'get_image': {
      const messageId = parseInt(query, 10)
      if (isNaN(messageId)) { console.error('Usage: npm run cli get_image <message_id>'); process.exit(1) }
      const result = await handleGetImage(messageId)
      if (result.file_available) {
        console.log(`file_path:      ${result.file_path}`)
        console.log(`file_available: true`)
        console.log(`ocr_text:       ${result.ocr_text ?? '(none)'}`)
        console.log(`content_base64: [${result.content_base64.length} chars]`)
      } else {
        console.log(`file_path:      ${result.file_path ?? '(none)'}`)
        console.log(`file_available: false`)
        console.log(`error:          ${result.error}`)
        console.log(`ocr_text:       ${result.ocr_text ?? '(none)'}`)
      }
      break
    }

    case 'index': {
      const force = parseForceArg(rawRest)
      await rebuildEmbeddings(undefined, force)
      process.exit(0)
    }

    default:
      console.error(`Unknown tool: ${tool}`)
      console.error('Run `npm run cli` for usage.')
      process.exit(1)
  }
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
