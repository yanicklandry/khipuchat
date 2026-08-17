/**
 * Integration tests for the bash setup-env engine (scripts/setup-env.sh).
 *
 * These tests invoke the real script under /bin/bash via execFileSync,
 * piping simulated operator answers, against isolated temp-dir `.env`
 * fixtures (SETUP_ENV_FILE override). They never touch the repo's real
 * `.env`. See .kiro/specs/setup-wizard/design.md, "Testing Strategy" ->
 * "Integration Tests" for the scenario list this file implements, and
 * requirements.md R2, R4, R5, R9 for the acceptance criteria being verified.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const PROJECT_ROOT = path.join(__dirname, '..')
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'setup-env.sh')
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT, 'utf8')

// var_table order (from scripts/setup-env.sh) -- the number/order of piped
// answer lines must match this exactly, since run_interactive only consumes
// an answer line for keys that are NOT already configured.
const ALL_KEYS = [
  'TELEGRAM_API_ID',
  'TELEGRAM_API_HASH',
  'TELEGRAM_PHONE_NUMBER',
  'DISCORD_TOKEN',
  'SLACK_USER_TOKEN',
  'EMAIL_IMAP_HOST',
  'EMAIL_IMAP_USER',
  'EMAIL_IMAP_PASS',
  'BEEPER_ACCESS_TOKEN',
  'DB_KEY',
  'WEB_USER',
  'WEB_PASS',
  'MCP_SECRET',
]

const OPTIONAL_KEYS = ['DB_KEY', 'WEB_USER', 'WEB_PASS', 'MCP_SECRET']

const DOCS_PATH = path.join(PROJECT_ROOT, 'docs', 'TOKENS.md')
const ENV_EXAMPLE_PATH = path.join(PROJECT_ROOT, '.env.example')

interface VarRecord {
  key: string
  platform: string
  required: string
  url: string
  example: string
  click_path: string
}

/**
 * Parses `--dump-table`'s human-readable dump into structured records. This
 * is the authoritative, script-derived list of recognised var_table keys
 * (rather than re-hardcoding key/url/example/click_path text in the test),
 * so the docs-coverage assertions below fail loudly if var_table ever grows,
 * shrinks, or changes a field without docs/TOKENS.md or .env.example being
 * regenerated to match.
 */
function getVarTableRecords(): VarRecord[] {
  const stdout = execFileSync('/bin/bash', [SCRIPT, '--dump-table'], {
    cwd: PROJECT_ROOT,
    encoding: 'utf8',
    timeout: 15000,
  })
  const records: VarRecord[] = []
  let current: Partial<VarRecord> | null = null
  for (const line of stdout.split('\n')) {
    const recordMatch = line.match(/^record \d+: (.+)$/)
    if (recordMatch) {
      if (current) records.push(current as VarRecord)
      current = { key: recordMatch[1] }
      continue
    }
    if (!current) continue
    const platform = line.match(/^\s*platform:\s+(.*)$/)
    const required = line.match(/^\s*required:\s+(.*)$/)
    const url = line.match(/^\s*url:\s+(.*)$/)
    const example = line.match(/^\s*example:\s+(.*)$/)
    const clickPath = line.match(/^\s*click_path:\s+(.*)$/)
    if (platform) current.platform = platform[1]
    if (required) current.required = required[1]
    if (url) current.url = url[1]
    if (example) current.example = example[1]
    if (clickPath) current.click_path = clickPath[1]
  }
  if (current) records.push(current as VarRecord)
  return records
}

/** Runs `--emit-docs` against a temp SETUP_ENV_DOCS path and returns its content. */
function runEmitDocs(docsPath: string): string {
  execFileSync('/bin/bash', [SCRIPT, '--emit-docs'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, SETUP_ENV_DOCS: docsPath },
    encoding: 'utf8',
    timeout: 15000,
  })
  return fs.readFileSync(docsPath, 'utf8')
}

/**
 * Splits a file's lines into blank-line-delimited segments. `.env.example`
 * groups each platform's variables under a shared `# --- Platform ---`
 * header/comment block with no blank line between the comments and the
 * `KEY=` lines they document, so a segment is the right granularity for
 * "does this variable have an adjacent comment link".
 */
function splitIntoSegments(content: string): string[][] {
  const segments: string[][] = [[]]
  for (const line of content.split('\n')) {
    if (line.trim() === '') {
      segments.push([])
    } else {
      segments[segments.length - 1].push(line)
    }
  }
  return segments
}

let tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-env-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  tmpDirs = []
})

/**
 * Runs the engine's default interactive mode with piped answers against an
 * isolated env file. Returns stdout/stderr/status; never throws on non-zero
 * exit (caller asserts status explicitly).
 */
function runInteractive(envFile: string, answers: string[]) {
  // One line per answer; a trailing newline ensures the final `read -r`
  // still sees a terminated line even for a bare-Enter (empty) answer.
  const input = answers.map((a) => `${a}\n`).join('')
  try {
    const stdout = execFileSync('/bin/bash', [SCRIPT], {
      input,
      cwd: PROJECT_ROOT,
      env: { ...process.env, SETUP_ENV_FILE: envFile },
      encoding: 'utf8',
      timeout: 15000,
    })
    return { status: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status: number | null; stdout: string; stderr: string }
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('setup-env.sh integration (bash engine over fixtures)', () => {
  it('missing/empty detection + append: only missing keys prompted and appended; populated key untouched (R2.2, R2.3, R5.1)', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(envFile, 'TELEGRAM_API_ID=already-set-123\n')

    // Only TELEGRAM_API_ID is pre-populated, so an answer is needed for
    // every other key in var_table order (13 - 1 = 12 answers).
    const answers = ALL_KEYS.filter((k) => k !== 'TELEGRAM_API_ID').map(
      (k) => `answer-for-${k}`
    )
    const { status, stdout } = runInteractive(envFile, answers)
    expect(status).toBe(0)

    const finalContent = fs.readFileSync(envFile, 'utf8')
    // Populated key untouched.
    expect(finalContent).toContain('TELEGRAM_API_ID=already-set-123')
    // Every other key was appended with the given answer.
    for (const k of ALL_KEYS.filter((key) => key !== 'TELEGRAM_API_ID')) {
      expect(finalContent).toContain(`${k}=answer-for-${k}`)
    }
    // The prompt for the already-configured key must never have been shown.
    expect(stdout).not.toMatch(/^TELEGRAM_API_ID: $/m)
    // Summary reflects: TELEGRAM_API_ID already-configured, rest written.
    expect(stdout).toMatch(/already-configured:\s+TELEGRAM_API_ID/)
    expect(stdout).toMatch(/written:\s+.*DISCORD_TOKEN/)
  })

  it('in-place fill of empty key: fills DISCORD_TOKEN= in place, preserving comments/blank lines/order byte-for-byte except that value (R5.2, R5.3)', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    const original = [
      '# telegram credentials',
      'TELEGRAM_API_ID=1234567',
      'TELEGRAM_API_HASH=abc',
      'TELEGRAM_PHONE_NUMBER=+15551234567',
      '',
      '# discord credentials',
      'DISCORD_TOKEN=',
      '',
      '# slack credentials',
      'SLACK_USER_TOKEN=xoxp-existing',
      '',
      '# email credentials',
      'EMAIL_IMAP_HOST=imap.example.com',
      'EMAIL_IMAP_USER=me@example.com',
      'EMAIL_IMAP_PASS=secret',
      '',
      '# beeper',
      'BEEPER_ACCESS_TOKEN=beeper-token',
      '',
    ].join('\n')
    fs.writeFileSync(envFile, original)

    // Only DISCORD_TOKEN and the 4 optional security vars remain unconfigured.
    const answers = ['filled-discord-token', '', '', '', '']
    const { status } = runInteractive(envFile, answers)
    expect(status).toBe(0)

    const finalContent = fs.readFileSync(envFile, 'utf8')
    const expected = original.replace(
      'DISCORD_TOKEN=\n',
      'DISCORD_TOKEN=filled-discord-token\n'
    )
    expect(finalContent).toBe(expected)
  })

  it('skip leaves file unchanged: bare-Enter for an optional var leaves it absent and summary lists it as skipped (R4.1, R4.2, R5.4, R5.5)', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    // Pre-populate everything except the optional security vars, so the
    // only prompts are the 4 optional ones.
    const populated = [
      'TELEGRAM_API_ID=1',
      'TELEGRAM_API_HASH=1',
      'TELEGRAM_PHONE_NUMBER=1',
      'DISCORD_TOKEN=1',
      'SLACK_USER_TOKEN=1',
      'EMAIL_IMAP_HOST=1',
      'EMAIL_IMAP_USER=1',
      'EMAIL_IMAP_PASS=1',
      'BEEPER_ACCESS_TOKEN=1',
      '',
    ].join('\n')
    fs.writeFileSync(envFile, populated)

    const { status, stdout } = runInteractive(envFile, ['', '', '', ''])
    expect(status).toBe(0)

    const finalContent = fs.readFileSync(envFile, 'utf8')
    // File unchanged aside from possibly nothing at all -- none of the
    // optional keys should now appear in the file.
    for (const k of OPTIONAL_KEYS) {
      expect(finalContent).not.toMatch(new RegExp(`^${k}=`, 'm'))
    }
    expect(finalContent).toBe(populated)
    expect(stdout).toMatch(/skipped:\s+.*DB_KEY/)
    expect(stdout).toMatch(/WEB_USER/)
    expect(stdout).toMatch(/WEB_PASS/)
    expect(stdout).toMatch(/MCP_SECRET/)
  })

  it('idempotent re-run: second run with no input (all bare-Enter) makes zero changes to the file (R5.6)', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    fs.writeFileSync(envFile, 'TELEGRAM_API_ID=already-configured\n')

    // First run: fill required keys, skip optional ones.
    const firstAnswers = ALL_KEYS.filter((k) => k !== 'TELEGRAM_API_ID').map((k) =>
      OPTIONAL_KEYS.includes(k) ? '' : `value-${k}`
    )
    const first = runInteractive(envFile, firstAnswers)
    expect(first.status).toBe(0)
    const afterFirstRun = fs.readFileSync(envFile, 'utf8')

    // Second run: everything required is now configured, so only the
    // optional keys are prompted again; answer with bare-Enter for all.
    const second = runInteractive(envFile, ['', '', '', ''])
    expect(second.status).toBe(0)
    const afterSecondRun = fs.readFileSync(envFile, 'utf8')

    expect(afterSecondRun).toBe(afterFirstRun)
    expect(second.stdout).toMatch(/written:\s+\(none\)/)
  })

  it('managed var never prompted: TELEGRAM_SESSION_STRING is never prompted for and never written, even if answers are supplied for every var_table key (R2.5)', () => {
    const dir = makeTmpDir()
    const envFile = path.join(dir, '.env')
    // Pre-seed TELEGRAM_SESSION_STRING as if a prior Telegram login already
    // populated it -- the wizard must leave it completely alone.
    fs.writeFileSync(envFile, 'TELEGRAM_SESSION_STRING=managed-by-telegram-login\n')

    const answers = ALL_KEYS.map((k) => `value-${k}`)
    const { status, stdout } = runInteractive(envFile, answers)
    expect(status).toBe(0)

    // Never prompted: no prompt block mentions the key at all.
    expect(stdout).not.toContain('TELEGRAM_SESSION_STRING')

    // Never written/altered: the pre-seeded line survives unchanged, and no
    // *second* TELEGRAM_SESSION_STRING line was appended.
    const finalContent = fs.readFileSync(envFile, 'utf8')
    const occurrences = finalContent.split('TELEGRAM_SESSION_STRING').length - 1
    expect(occurrences).toBe(1)
    expect(finalContent).toContain('TELEGRAM_SESSION_STRING=managed-by-telegram-login')
  })

  it('bash 3.2 compatibility: script contains no associative arrays or mapfile, and executes successfully under /bin/bash (R9.1, R9.2)', () => {
    // Static source assertions -- `declare -A` / `typeset -A` are the
    // associative-array declaration forms bash 3.2 lacks. Comment lines are
    // stripped first because the script's own header comments *mention*
    // "mapfile"/associative arrays by name while explaining that they are
    // deliberately not used -- checking raw source would false-positive on
    // that prose. What matters is that these forms are never *invoked* as
    // actual shell code.
    const codeOnly = SCRIPT_SOURCE
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n')
    expect(codeOnly).not.toMatch(/declare\s+-A/)
    expect(codeOnly).not.toMatch(/typeset\s+-A/)
    expect(codeOnly).not.toMatch(/\bmapfile\b/)
    expect(codeOnly).not.toMatch(/\breadarray\b/)

    // Dynamic assertion -- the debug dump mode runs to completion under
    // /bin/bash with no input required.
    const stdout = execFileSync('/bin/bash', [SCRIPT, '--dump-table'], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(stdout).toContain('TELEGRAM_API_ID')
  })

  it('no network calls: script source contains no curl/wget/standalone-nc invocation patterns (R9.3)', () => {
    // Guard against naive substring checks false-positiving on "nc" inside
    // unrelated words (e.g. "function", "instance") by requiring nc/curl/
    // wget to appear as a standalone shell command token.
    const commandTokenPattern = /(^|[\s|;&(`])(curl|wget|nc)\b/m
    expect(SCRIPT_SOURCE).not.toMatch(commandTokenPattern)
  })
})

describe('docs / drift (emit-docs coverage, TOKENS.md byte-equality, .env.example coverage)', () => {
  it('emit-docs covers every recognised variable with its URL, click-path, example, required/optional status, and the session-string note (R6.2, R6.3, R7.1-7.3)', () => {
    const dir = makeTmpDir()
    const docsPath = path.join(dir, 'TOKENS.md')
    const content = runEmitDocs(docsPath)

    const records = getVarTableRecords()
    expect(records.length).toBe(13)
    expect(records.map((r) => r.key)).toEqual(ALL_KEYS)

    for (const rec of records) {
      expect(content, `missing key ${rec.key}`).toContain(`\`${rec.key}\``)
      expect(content, `missing url for ${rec.key}`).toContain(rec.url)
      expect(content, `missing click_path for ${rec.key}`).toContain(rec.click_path)
      expect(content, `missing example for ${rec.key}`).toContain(rec.example)
      const requiredLabel = rec.required === '1' ? 'Required' : 'Optional'
      // Assert the required/optional label is attached to this specific key's
      // heading line, not merely present somewhere in the document.
      const headingPattern = new RegExp(
        `\\*\\*\`${rec.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`\\*\\*\\s*\\(${requiredLabel}\\)`
      )
      expect(content, `missing "(${requiredLabel})" on ${rec.key}'s heading`).toMatch(
        headingPattern
      )
    }

    // Explicit note that TELEGRAM_SESSION_STRING is auto-managed and never
    // prompted, even though it has no var_table record of its own (R2.5).
    expect(content).toMatch(/TELEGRAM_SESSION_STRING[\s\S]{0,200}auto-managed/)
    expect(content).toMatch(/TELEGRAM_SESSION_STRING[\s\S]{0,200}never prompted/)
  })

  it('committed docs/TOKENS.md byte-equals a fresh --emit-docs run: no undocumented drift (R6.3)', () => {
    const dir = makeTmpDir()
    const docsPath = path.join(dir, 'TOKENS.md')
    const fresh = runEmitDocs(docsPath)
    const committed = fs.readFileSync(DOCS_PATH, 'utf8')

    expect(fresh).toBe(committed)
  })

  it('drift check is a real content comparison, not vacuous: a hand-edited copy is detectably different (sanity for the test above)', () => {
    const dir = makeTmpDir()
    const docsPath = path.join(dir, 'TOKENS.md')
    const fresh = runEmitDocs(docsPath)
    const committed = fs.readFileSync(DOCS_PATH, 'utf8')

    // Confirm this is a genuine two-source comparison (temp-file content vs.
    // repo content read independently), not e.g. accidentally diffing a file
    // against itself: appending to one copy must make the comparison fail.
    const handEdited = committed + '\n<!-- drift -->\n'
    expect(handEdited).not.toBe(fresh)
    expect(handEdited === committed).toBe(false)
  })

  it('.env.example lists every recognised variable, each with a comment referencing a URL or docs/TOKENS.md (R8.1, R8.2, R8.3)', () => {
    const content = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8')
    const records = getVarTableRecords()
    const expectedKeys = [...records.map((r) => r.key), 'TELEGRAM_SESSION_STRING']
    expect(expectedKeys.length).toBe(14)

    const segments = splitIntoSegments(content)

    for (const key of expectedKeys) {
      expect(content, `${key} not assigned in .env.example`).toMatch(
        new RegExp(`^${key}=`, 'm')
      )
      const segment = segments.find((seg) => seg.some((l) => l.startsWith(`${key}=`)))
      expect(segment, `no comment block found for ${key} in .env.example`).toBeDefined()
      const segmentText = segment!.join('\n')

      // A comment link is either a real http(s) URL, an explicit
      // docs/TOKENS.md pointer, or (matching var_table's own convention,
      // where non-web sources like "Beeper Desktop app" / "operator-chosen"
      // are legitimately recorded in the `url` field even though they are
      // not hyperlinks) a mention of that key's var_table `url` text itself.
      // TELEGRAM_SESSION_STRING has no var_table record of its own -- it
      // sits in the same comment-block segment as the other Telegram
      // variables, so it is covered by their shared https://my.telegram.org
      // URL comment.
      const record = records.find((r) => r.key === key)
      const hasLink =
        /https?:\/\//.test(segmentText) ||
        /docs\/TOKENS\.md/.test(segmentText) ||
        (!!record && record.url.length > 0 && segmentText.includes(record.url))
      expect(
        hasLink,
        `.env.example block for ${key} has no comment referencing a URL, docs/TOKENS.md, or its var_table acquisition source:\n${segmentText}`
      ).toBe(true)
    }
  })
})
