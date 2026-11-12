// Entry for `khipu import zalo-history`: argument parsing, account resolution,
// the fidelity disclosure (6.3), operator error messages, and exit codes (7.4).
// The real ports are wired only in main(); run() takes them injected for tests (8.5).
import 'dotenv/config'
import { initDb } from '../../../db'
import { loadRegistry, type AccountRegistry } from '../../../account-registry'
import { createAppControl } from './app-control'
import { createCdpClient } from './cdp'
import { runImport as runImportImpl, type ImportDeps } from './importer'
import { createStoreReader } from './store-reader'
import { createUidStore } from './uid-store'
import type { ImportError, ImportSummary, Reporter, Result } from './types'

export const DISCLOSURE =
  'Recovers only history already synced to this Zalo PC install. Uses undocumented Zalo PC internals that may break on app updates. Zalo PC will be restarted.'

export const SHAPE_HINT =
  'Some conversations had data this importer does not recognise; the importer may need updating for this Zalo PC version.'

export const USAGE = `Usage: khipu import zalo-history [--account <name>] [--app-path <path to Zalo.app>]

Imports the DM history held by the Zalo PC desktop app (macOS) into the archive.
Zalo PC must be installed and logged in. It is restarted hidden with local
debugging enabled, then reopened normally. Re-running never duplicates messages.

Options:
  --account <name>     Zalo account to attribute history to (default: "default", or the only account)
  --app-path <path>    Location of Zalo.app if it is not in /Applications or ~/Applications
  -h, --help           Show this help`

export interface CliArgs { account: string | null; appPath: string | null; help: boolean }

export function parseArgs(argv: string[]): CliArgs | { error: string } {
  const args: CliArgs = { account: null, appPath: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]!
    if (raw === '-h' || raw === '--help') { args.help = true; continue }
    const eq = raw.indexOf('=')
    const flag = eq >= 0 ? raw.slice(0, eq) : raw
    if (flag !== '--account' && flag !== '--app-path') return { error: `Unknown option: ${raw}` }
    const value = eq >= 0 ? raw.slice(eq + 1) : argv[++i]
    if (!value || value.startsWith('-')) return { error: `${flag} needs a value` }
    if (flag === '--account') args.account = value
    else args.appPath = value
  }
  return args
}

export function resolveAccount(requested: string | null, available: readonly string[]): { account: string } | { error: string } {
  if (available.length === 0) return { error: 'No Zalo account is configured. Add a zalo account to khipu.config.json.' }
  if (requested !== null) {
    return available.includes(requested)
      ? { account: requested }
      : { error: `Zalo account "${requested}" is not configured. Choose one of: ${available.join(', ')}.` }
  }
  if (available.includes('default')) return { account: 'default' }
  if (available.length === 1) return { account: available[0]! }
  return { error: `Several Zalo accounts are configured; pass --account with one of: ${available.join(', ')}.` }
}

export function exitCodeFor(result: Result<ImportSummary>): 0 | 1 {
  return result.ok && result.value.failed.length === 0 ? 0 : 1
}

export function errorMessage(e: ImportError, account: string): string {
  switch (e.kind) {
    case 'not_installed':
      return `Zalo PC not found. Looked in: ${e.searched.join(', ')}. Pass --app-path <path to Zalo.app>.`
    case 'launch_failed':
    case 'attach_failed':
      return `Could not start or attach to Zalo PC: ${e.message.replace(/\.$/, '')}.`
    case 'not_logged_in':
      return 'Zalo PC is not logged in. Log in to Zalo PC, then re-run.'
    case 'shape_unrecognised':
      return `This Zalo PC version (${e.zaloVersion ?? 'unknown'}) is not supported by the importer: ${e.detail}. The importer needs updating.`
    case 'account_mismatch':
      return e.expectedUid === null
        ? `Zalo PC is logged in as ${e.actualUid}, but that Zalo user is already linked to account ${e.boundAccount ?? 'another account'}, not ${account}. Pass --account ${e.boundAccount ?? '<name>'} or log in as the right user. Nothing was imported.`
        : `Zalo PC is logged in as ${e.actualUid}, but account ${account} expects ${e.expectedUid}. Nothing was imported.`
    case 'uid_store_invalid':
      return `The Zalo account link file ${e.path} is corrupt. Fix or delete it, then re-run.`
    case 'connection_lost':
      return `Lost connection to Zalo PC after ${e.conversationsDone} conversations. Re-run to continue; nothing is duplicated.`
  }
}

export interface ImportOptions { account: string; appPath: string | null; configuredUid: string | null; reporter: Reporter }

export interface CliIo {
  out(line: string): void
  err(line: string): void
  listAccounts(): readonly string[]
  fieldsFor(account: string): Readonly<Record<string, string>>
  /** Opens the archive; called only once the arguments and account are valid. */
  openArchive(): void
  runImport(opts: ImportOptions): Promise<Result<ImportSummary>>
}

function summaryLines(s: ImportSummary): string[] {
  return [
    `Done: ${s.conversations} conversations, ${s.added} messages added, ${s.alreadyPresent} already present, ${s.skipped} skipped, ${s.failed.length} failed.`,
    ...s.failed.map((f) => `  failed ${f.name}: ${f.reason}`),
  ]
}

export async function run(argv: string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)
  if ('error' in args) { io.err(`${args.error}\n\n${USAGE}`); return 1 }
  if (args.help) { io.out(USAGE); return 0 }
  const resolved = resolveAccount(args.account, io.listAccounts())
  if ('error' in resolved) { io.err(resolved.error); return 1 }
  const { account } = resolved
  const configuredUid = io.fieldsFor(account)['ZALO_UID'] || null

  io.out(DISCLOSURE)
  io.openArchive()
  const reporter: Reporter = {
    info: (l) => io.out(l),
    progress: (name, read) => io.out(`  ${name}: ${read} messages read`),
    warn: (l) => io.err(l),
  }
  const result = await io.runImport({ account, appPath: args.appPath, configuredUid, reporter })
  if (result.ok) {
    for (const l of summaryLines(result.value)) io.out(l)
    if (result.value.failed.some((f) => f.reason.startsWith('shape_unrecognised'))) io.err(SHAPE_HINT)
  }
  else io.err(errorMessage(result.error, account))
  return exitCodeFor(result)
}

/** Real ports: loopback CDP, macOS app control, the renderer store reader, and .zalo_uids.json. */
function realImport(opts: ImportOptions): Promise<Result<ImportSummary>> {
  const cdp = createCdpClient()
  const deps: ImportDeps = {
    app: createAppControl({ cdp, ...(opts.appPath ? { appPath: opts.appPath } : {}) }),
    reporter: opts.reporter,
    uidStore: createUidStore(),
    openReader: async (instance, zaloVersion) => {
      try {
        const session = await cdp.connect(instance.target)
        const chromium = (await cdp.version(instance.port).catch(() => ({ browser: 'unknown' }))).browser
        return { ok: true, value: { reader: createStoreReader(session, zaloVersion), session, chromium } }
      } catch (err) {
        return { ok: false, error: { kind: 'attach_failed', step: 'attach', message: (err as Error).message } }
      }
    },
  }
  return runImportImpl(deps, opts.account, opts.configuredUid)
}

export async function main(argv: string[]): Promise<number> {
  // Loaded lazily so --help and argument errors work even with a broken khipu.config.json.
  let loaded: AccountRegistry | null = null
  const registry = (): AccountRegistry => (loaded ??= loadRegistry())
  return run(argv, {
    openArchive: () => { initDb('./khipuchat.db') },
    out: (l) => console.log(l),
    err: (l) => console.error(l),
    listAccounts: () => registry().listAccounts('zalo'),
    fieldsFor: (account) => registry().credentialsFor('zalo', account).fields,
    runImport: realImport,
  })
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((err: unknown) => {
    console.error(err)
    process.exit(1)
  })
}
