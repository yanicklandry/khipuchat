import { Router } from 'express'
import type { Request, Response } from 'express'
import expressBasicAuth from 'express-basic-auth'
import { handleListChats, handleSearchMessages, handleListMessages } from '../mcp'

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

    const result = handleListMessages(chatId, { before, limit })
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
