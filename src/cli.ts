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
import type { MessageFilters } from './vec-db'
import {
  handleListChats,
  handleFindChatByName,
  handleListMessages,
  handleSearchMessages,
  handleGetChatSummary,
  handleSemanticFindContacts,
  handleSemanticSearchMessages,
} from './mcp'

initDb(path.join(__dirname, '..', 'khipuchat.db'))

const [, , tool, ...rest] = process.argv
const query = rest[0] ?? ''

function ts(t: number) {
  return new Date(t * 1000).toLocaleString()
}

/**
 * Detect temporal keywords in a query and return corresponding timestamp filters.
 * Also returns the query with the temporal phrase stripped so it doesn't confuse the embedder.
 */
function parseTemporalFilters(query: string): { filters: Pick<MessageFilters, 'after_timestamp' | 'before_timestamp'>; cleanQuery: string } {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const filters: Pick<MessageFilters, 'after_timestamp' | 'before_timestamp'> = {}
  let cleanQuery = query

  const temporal: Array<{ pattern: RegExp; after: () => Date; before?: () => Date; label?: string }> = [
    {
      // "tonight" / "today" — event may have been announced up to 7 days ago
      pattern: /\b(tonight|today)\b/i,
      after: () => new Date(today.getTime() - 7 * 86400_000),
      label: 'last 7 days (event announcements for today)',
    },
    {
      pattern: /\byesterday\b/i,
      after: () => new Date(today.getTime() - 8 * 86400_000),
      before: () => today,
    },
    {
      pattern: /\bthis week\b/i,
      after: () => new Date(today.getTime() - 7 * 86400_000),
    },
    {
      pattern: /\bthis month\b/i,
      after: () => new Date(today.getFullYear(), today.getMonth(), 1),
    },
    {
      pattern: /\brecently\b|\brecent\b/i,
      after: () => new Date(today.getTime() - 30 * 86400_000),
    },
  ]

  for (const { pattern, after, before } of temporal) {
    if (pattern.test(query)) {
      filters.after_timestamp = Math.floor(after().getTime() / 1000)
      if (before) filters.before_timestamp = Math.floor(before().getTime() / 1000)
      cleanQuery = query.replace(pattern, '').replace(/\s{2,}/g, ' ').trim()
      break
    }
  }

  return { filters, cleanQuery }
}

async function main() {
  if (!tool) {
    console.log(`Usage: npm run cli <tool> [query]

Tools:
  semantic-search <query>     Semantic search across all messages
  semantic-contacts <query>   Find contacts by meaning
  search <query>              Keyword search across messages
  list-chats                  List all chats
  find-chat <name>            Find chats by name
  messages <chat_id>          List recent messages in a chat
  summary <chat_id>           Get chat summary
`)
    process.exit(0)
  }

  switch (tool) {
    case 'semantic-search': {
      if (!query) { console.error('Usage: npm run cli semantic-search "your query"'); process.exit(1) }
      const { filters: temporalFilters, cleanQuery } = parseTemporalFilters(query)
      const hasTimeFilter = temporalFilters.after_timestamp !== undefined
      console.log(`\nSemantic search: "${query}"`)
      if (hasTimeFilter) {
        const afterDate = new Date(temporalFilters.after_timestamp! * 1000).toLocaleDateString()
        console.log(`  Searching messages since: ${afterDate}`)
      }
      console.log()
      const result = await handleSemanticSearchMessages(cleanQuery, { limit: 20, ...temporalFilters })
      if ('error' in result) { console.error(result.error); process.exit(1) }
      if (result.length === 0) { console.log('No results found.'); break }
      for (const r of result) {
        console.log(`[${ts(r.timestamp)}] ${r.chat_name} (${r.platform})`)
        if (r.sender_name) console.log(`  ${r.sender_name}: ${r.text ?? ''}`)
        else console.log(`  ${r.text ?? ''}`)
        console.log(`  similarity: ${((1 - r.distance) * 100).toFixed(0)}%\n`)
      }
      break
    }

    case 'semantic-contacts': {
      if (!query) { console.error('Usage: npm run cli semantic-contacts "your query"'); process.exit(1) }
      console.log(`\nSemantic contact search: "${query}"\n`)
      const result = await handleSemanticFindContacts(query, { limit: 10 })
      if ('error' in result) { console.error(result.error); process.exit(1) }
      if (result.length === 0) { console.log('No contacts found.'); break }
      for (const r of result) {
        console.log(`${r.name} (${r.platform}) — ${r.message_count} messages`)
        if (r.snippet) console.log(`  "${r.snippet.slice(0, 80)}"`)
        console.log()
      }
      break
    }

    case 'search': {
      if (!query) { console.error('Usage: npm run cli search "your query"'); process.exit(1) }
      console.log(`\nKeyword search: "${query}"\n`)
      const results = handleSearchMessages(query)
      if (results.length === 0) { console.log('No results found.'); break }
      for (const r of results) {
        console.log(`[${ts(r.timestamp)}] Chat #${r.chat_id} (${r.platform})`)
        if (r.sender_name) console.log(`  ${r.sender_name}: ${r.text}`)
        else console.log(`  ${r.text}`)
        console.log()
      }
      break
    }

    case 'list-chats': {
      const chats = handleListChats()
      for (const c of chats.slice(0, 30)) {
        console.log(`[${c.chat_id}] ${c.name} (${c.platform}, ${c.type}, ${c.message_count} msgs)`)
      }
      if (chats.length > 30) console.log(`  … and ${chats.length - 30} more`)
      break
    }

    case 'find-chat': {
      if (!query) { console.error('Usage: npm run cli find-chat "name"'); process.exit(1) }
      const chats = handleFindChatByName(query)
      if (chats.length === 0) { console.log('No chats found.'); break }
      for (const c of chats) {
        console.log(`[${c.chat_id}] ${c.name} (${c.platform}, ${c.type}, ${c.message_count} msgs)`)
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

    default:
      console.error(`Unknown tool: ${tool}`)
      console.error('Run `npm run cli` for usage.')
      process.exit(1)
  }
}

main().catch((err: unknown) => { console.error(err); process.exit(1) })
