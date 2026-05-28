// Stub required env vars before any test module loads.
// config.ts evaluates these at import time, so they must be present
// in the environment before the module is first imported.
process.env['TELEGRAM_API_ID'] ??= '12345'
process.env['TELEGRAM_API_HASH'] ??= 'testhash'
process.env['TELEGRAM_PHONE_NUMBER'] ??= '+10000000000'
