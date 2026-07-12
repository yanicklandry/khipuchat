import express from 'express'
import type { Application, Request, Response } from 'express'
import type { Server } from 'node:http'
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

// Extracted from main(); default host guarantees localhost-only binding.
export function startServer(
  app: Application,
  host: string = '127.0.0.1',
  port: number = 3333,
): Server {
  const server = app.listen(port, host, () => {
    console.log(`KhipuChat web UI running at http://${host}:${port}`)
  })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`Port ${port} is already in use. Stop the existing process and try again.\n`)
      process.exit(1)
    }
    throw err
  })
  return server
}

async function main(): Promise<void> {
  initDb('./khipuchat.db')
  startServer(createApp())
}

if (require.main === module) {
  main().catch((err: unknown) => { console.error(err); process.exit(1) })
}
