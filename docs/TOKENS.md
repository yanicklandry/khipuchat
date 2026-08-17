# TOKENS.md

Reference for acquiring every credential recognised by `khipu setup-env`.
Generated from the single source-of-truth variable table in
`scripts/setup-env.sh` (`var_table`); do not hand-edit this file, run
`khipu setup-env --emit-docs` (or `scripts/setup-env.sh --emit-docs`) to
regenerate it instead.

> **`TELEGRAM_SESSION_STRING`** is not listed below: it is auto-managed,
> produced automatically at first Telegram login, and is never prompted
> for by `khipu setup-env`.

## Telegram

- **`TELEGRAM_API_ID`** (Required)
  - URL: https://my.telegram.org/apps
  - Click-path: Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
  - Example: `1234567`
- **`TELEGRAM_API_HASH`** (Required)
  - URL: https://my.telegram.org/apps
  - Click-path: Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
  - Example: `0123456789abcdef0123456789abcdef`
- **`TELEGRAM_PHONE_NUMBER`** (Required)
  - URL: https://my.telegram.org/apps
  - Click-path: Open https://my.telegram.org => log in with your phone (+countrycode) and the code sent in your Telegram app => click "API development tools" => copy the "App api_id" and "App api_hash" fields
  - Example: `+14155552671`

## Discord

- **`DISCORD_TOKEN`** (Required)
  - URL: https://discord.com/developers/applications
  - Click-path: Open https://discord.com/developers/applications => New Application => Bot => Reset Token => Copy. Enable "Message Content Intent" if reading message text
  - Example: `MTk4N... (bot token)`

## Slack

- **`SLACK_USER_TOKEN`** (Required)
  - URL: https://api.slack.com/apps
  - Click-path: Open https://api.slack.com/apps => Create New App => From scratch => OAuth & Permissions => add User Token Scopes (channels:history, groups:history, im:history, mpim:history, users:read) => Install to Workspace => copy the "User OAuth Token" starting with xoxp-
  - Example: `xoxp-...`

## Email/IMAP

- **`EMAIL_IMAP_HOST`** (Required)
  - URL: (provider docs; Gmail: imap.gmail.com)
  - Click-path: Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
  - Example: `imap.gmail.com`
- **`EMAIL_IMAP_USER`** (Required)
  - URL: (provider account)
  - Click-path: Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
  - Example: `you@gmail.com`
- **`EMAIL_IMAP_PASS`** (Required)
  - URL: https://myaccount.google.com/apppasswords
  - Click-path: Use your provider's IMAP host (Gmail: imap.gmail.com, port 993 SSL). Enable 2-Step Verification, then create an App Password at https://myaccount.google.com/apppasswords and use it as EMAIL_IMAP_PASS (your normal password will not work)
  - Example: `abcd efgh ijkl mnop (app password)`

## Beeper (Signal / Facebook Messenger)

- **`BEEPER_ACCESS_TOKEN`** (Required)
  - URL: Beeper Desktop app
  - Click-path: Open Beeper Desktop => Settings => Integrations => click "+" next to Approved connections => create the token. This token backs Signal and Facebook Messenger
  - Example: `(token from Beeper Desktop)`

## Security (optional)

- **`DB_KEY`** (Optional)
  - URL: steering: security-hardening
  - Click-path: Operator-chosen; see steering security-hardening notes
  - Example: `(SQLCipher passphrase)`
- **`WEB_USER`** (Optional)
  - URL: operator-chosen
  - Click-path: Operator-chosen; see steering security-hardening notes
  - Example: `admin`
- **`WEB_PASS`** (Optional)
  - URL: operator-chosen
  - Click-path: Operator-chosen; see steering security-hardening notes
  - Example: `(web basic-auth password)`
- **`MCP_SECRET`** (Optional)
  - URL: operator-chosen
  - Click-path: Operator-chosen; see steering security-hardening notes
  - Example: `(MCP bearer token)`

