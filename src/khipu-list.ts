#!/usr/bin/env node
import * as path from 'path'
import { initDb } from './db'
import { handleListChats, handleListArchiveMessages, listArchiveAccounts } from './query-handlers'
import type { ChatResult, QueryFilters } from './query-handlers'
import type { MessageResult } from './db'
import { parseQueryFilters } from './cli-filters'
import { formatPlatformLabel } from './cli'

const LIST_USAGE = `Usage: khipu list <subcommand> [options]

Subcommands:
  chats      List all chats
  messages   List messages from the archive

Options:
  --platform <p>    Filter by platform
  --account <a>     Filter by account
  --since <date>    Filter by date (YYYY-MM-DD)
  --until <date>    Filter by date (YYYY-MM-DD)
  --type <t>        Filter by type
  --limit <n>       Max results (default 50)
`

function ts(t: number): string {
  return new Date(t * 1000).toLocaleString()
}

// ── Deps interface (injected for testability) ─────────────────────────────────

export interface ListDeps {
  handleListChats: (filters?: QueryFilters) => ChatResult[]
  handleListArchiveMessages: (filters?: QueryFilters) => { messages: MessageResult[]; has_more: boolean }
  listArchiveAccounts: () => { platform: string; account: string }[]
}

// ── Core logic ────────────────────────────────────────────────────────────────

export async function runList(args: string[], deps: ListDeps): Promise<void> {
  const parseResult = parseQueryFilters(args)
  if (!parseResult.ok) {
    console.error(parseResult.error)
    process.exit(1)
  }

  const { filters, rest } = parseResult
  const subcommand = rest[0]

  if (!subcommand || (subcommand !== 'chats' && subcommand !== 'messages')) {
    console.error(LIST_USAGE)
    process.exit(1)
  }

  const archiveAccounts = deps.listArchiveAccounts()
  const isMultiAccount = new Set(archiveAccounts.map(a => a.account)).size > 1

  if (subcommand === 'chats') {
    const chats = deps.handleListChats(filters)
    if (chats.length === 0) {
      console.log('No chats found.')
      return
    }
    for (const c of chats) {
      const label = formatPlatformLabel(c.platform, c.account, isMultiAccount)
      console.log(`[${c.chat_id}] ${c.name} (${label}, ${c.type}, ${c.message_count} msgs)`)
    }
  } else {
    const { messages, has_more } = deps.handleListArchiveMessages(filters)
    if (messages.length === 0) {
      console.log('No messages found.')
      return
    }
    for (const m of messages) {
      const label = formatPlatformLabel(m.platform, m.account, isMultiAccount)
      console.log(`[${ts(m.timestamp)}] Chat #${m.chat_id} (${label})`)
      if (m.sender_name) console.log(`  ${m.sender_name}: ${m.text?.slice(0, 120) ?? ''}`)
      else console.log(`  ${m.text?.slice(0, 120) ?? ''}`)
      console.log()
    }
    if (has_more) console.log('(more results available — use --limit to see more)')
  }
}

// ── Script entry ──────────────────────────────────────────────────────────────

if (require.main === module) {
  initDb(path.join(__dirname, '..', 'khipuchat.db'))

  const args = process.argv.slice(2)
  runList(args, { handleListChats, handleListArchiveMessages, listArchiveAccounts }).catch(
    (err: unknown) => {
      console.error(err)
      process.exit(1)
    },
  )
}
