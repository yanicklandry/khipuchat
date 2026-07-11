import express from 'express'
import type { Application, Request, Response } from 'express'
import { initDb } from '../db'
import { listArchiveAccounts } from '../query-handlers'
import router from './routes'
import { buildHtmlPage } from './ui'

export function createApp(): Application {
  const app = express()
  app.use(router)
  app.get('/', (req: Request, res: Response) => {
    const accounts = listArchiveAccounts()
    const accountParam = req.query['account']
    const selectedAccount = typeof accountParam === 'string' && accountParam ? accountParam : undefined
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.send(buildHtmlPage(accounts, selectedAccount))
  })
  return app
}

async function main(): Promise<void> {
  initDb('./khipuchat.db')
  const app = createApp()
  const server = app.listen(3333, '127.0.0.1', () => {
    console.log('KhipuChat web UI running at http://127.0.0.1:3333')
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write('Port 3333 is already in use. Stop the existing process and try again.\n')
      process.exit(1)
    }
    throw err
  })
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
