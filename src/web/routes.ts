import { Router } from 'express'
import type { Request, Response } from 'express'
import expressBasicAuth from 'express-basic-auth'
import { handleListChats, handleSearchMessages } from '../mcp'
import { getDb } from '../db'
import type { MessageRow } from '../db'

const router = Router()

router.use((req, res, next) => {
  if (!req.path.startsWith('/api')) { next(); return }
  const webUser = process.env['WEB_USER']
  const webPass = process.env['WEB_PASS']
  if (!webUser || !webPass) { next(); return }
  expressBasicAuth({ users: { [webUser]: webPass }, challenge: true })(req, res, next)
})

router.get('/api/chats', (_req: Request, res: Response) => {
  try {
    res.json(handleListChats())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/api/search', (req: Request, res: Response) => {
  try {
    const q = req.query['q']
    if (typeof q !== 'string' || q.trim() === '') {
      res.json([])
      return
    }
    res.json(handleSearchMessages(q))
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/api/messages/:chatId', (req: Request, res: Response) => {
  try {
    const chatId = parseInt(req.params['chatId'] ?? '', 10)
    if (isNaN(chatId)) {
      res.status(400).json({ error: 'invalid chatId' })
      return
    }

    // Parse optional `before` param (positive integer unix timestamp)
    let before: number | undefined
    const beforeRaw = req.query['before']
    if (beforeRaw !== undefined) {
      const beforeVal = Number(beforeRaw)
      if (!Number.isInteger(beforeVal) || beforeVal <= 0) {
        res.status(400).json({ error: 'invalid before parameter' })
        return
      }
      before = beforeVal
    }

    // Parse optional `limit` param (1–100, default 50)
    let limit = 50
    const limitRaw = req.query['limit']
    if (limitRaw !== undefined) {
      const limitVal = Number(limitRaw)
      if (!Number.isInteger(limitVal) || limitVal < 1 || limitVal > 100) {
        res.status(400).json({ error: 'invalid limit parameter' })
        return
      }
      limit = limitVal
    }

    // Fetch limit+1 rows in DESC order to detect has_more, then re-order ASC.
    // Fetching DESC first ensures we always get the *most recent* N messages
    // (same pattern as handleListMessages in mcp.ts).
    let descRows: MessageRow[]
    if (before !== undefined) {
      descRows = getDb().prepare(`
        SELECT * FROM messages
        WHERE chat_id = ? AND timestamp < ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(chatId, before, limit + 1) as MessageRow[]
    } else {
      descRows = getDb().prepare(`
        SELECT * FROM messages
        WHERE chat_id = ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(chatId, limit + 1) as MessageRow[]
    }
    const has_more = descRows.length > limit
    // Take at most `limit` rows (dropping the extra probe row), then re-order ASC
    const messages = descRows.slice(0, limit).reverse()
    res.json({ messages, has_more })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
