import { BeeperDesktop, APIConnectionError, AuthenticationError } from '@beeper/desktop-api'

export type Account = BeeperDesktop.Accounts.Account
export type BeeperChat = BeeperDesktop.Chats.Chat
export type BeeperMessage = BeeperDesktop.Message

export interface BeeperSignalClient {
  /** Signal account IDs resolved from network === 'signal'. Empty means no Signal connected. */
  signalAccountIds(): Promise<readonly string[]>
  /** All Signal chats, paginated internally. */
  listChats(): AsyncGenerator<BeeperChat>
  /** All messages for one chat, newest to oldest, paginated internally. */
  listChatMessages(chatId: string): AsyncGenerator<BeeperMessage>
  /** Messages in one chat strictly after `since` (incremental). */
  listNewChatMessages(chatId: string, since: Date): AsyncGenerator<BeeperMessage>
}

export function createBeeperSignalClient(accessToken: string): BeeperSignalClient {
  if (!accessToken) {
    throw new Error(
      'BEEPER_ACCESS_TOKEN is required. Set it in your khipu.config.json or environment before running Signal sync.',
    )
  }

  const beeper = new BeeperDesktop({ accessToken, baseURL: 'http://localhost:23373' })

  let cachedAccountIds: readonly string[] | null = null

  async function signalAccountIds(): Promise<readonly string[]> {
    if (cachedAccountIds !== null) return cachedAccountIds

    let accounts: Account[]
    try {
      accounts = await beeper.accounts.list()
    } catch (err) {
      cachedAccountIds = null
      throw wrapBeeperError(err)
    }

    cachedAccountIds = accounts
      .filter(a => a.network?.toLowerCase() === 'signal')
      .map(a => a.accountID)
    return cachedAccountIds
  }

  async function* listChats(): AsyncGenerator<BeeperChat> {
    const accountIDs = await signalAccountIds()
    if (accountIDs.length === 0) return

    try {
      for await (const chat of beeper.chats.search({ accountIDs: accountIDs as string[] })) {
        yield chat
      }
    } catch (err) {
      throw wrapBeeperError(err)
    }
  }

  async function* listChatMessages(chatId: string): AsyncGenerator<BeeperMessage> {
    const accountIDs = await signalAccountIds()
    if (accountIDs.length === 0) return

    try {
      // messages.search scopes by accountIDs (required invariant) and chatIDs, newest-to-oldest
      for await (const message of beeper.messages.search({
        chatIDs: [chatId],
        accountIDs: accountIDs as string[],
        direction: 'before',
      })) {
        yield message
      }
    } catch (err) {
      throw wrapBeeperError(err)
    }
  }

  async function* listNewChatMessages(chatId: string, since: Date): AsyncGenerator<BeeperMessage> {
    const accountIDs = await signalAccountIds()
    if (accountIDs.length === 0) return

    try {
      for await (const message of beeper.messages.search({
        chatIDs: [chatId],
        accountIDs: accountIDs as string[],
        dateAfter: since.toISOString(),
      })) {
        yield message
      }
    } catch (err) {
      throw wrapBeeperError(err)
    }
  }

  return { signalAccountIds, listChats, listChatMessages, listNewChatMessages }
}

function wrapBeeperError(err: unknown): Error {
  if (err instanceof APIConnectionError) {
    return new Error(
      `Cannot connect to Beeper Desktop (ECONNREFUSED). Ensure Beeper Desktop is running at localhost:23373. Original: ${(err as Error).message}`,
    )
  }
  if (err instanceof AuthenticationError) {
    return new Error(
      `Beeper Desktop rejected the access token (401). Check your BEEPER_ACCESS_TOKEN. Original: ${(err as Error).message}`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}
