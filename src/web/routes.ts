import { Router } from 'express'
import type { Request, Response } from 'express'
import expressBasicAuth from 'express-basic-auth'
import { handleListChats, handleSearchMessages } from '../mcp'
import { getMessages } from '../db'

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
    // Use getMessages (not handleListMessages) so all message types are returned,
    // not just text. The web UI handles media/other with a [media] placeholder.
    res.json(getMessages(chatId, 500))
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export default router
