import { describe, it, expect } from 'vitest'
import { mapMessage, type WechatMessageRow } from '../src/platforms/wechat/sync'

describe('WeChat Image Message Detection', () => {
  // Legacy schema test cases (WeChat 3.x)
  describe('Legacy schema image detection', () => {
    it('detects image messages with Type=4', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1001,
        CreateTime: 1700000000,
        Message: 'Hello',
        Type: 4, // Image type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })

    it('detects image messages with Type=4 (sent by user)', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1002,
        CreateTime: 1700000001,
        Message: 'Hello',
        Type: 4, // Image type
        Des: 0, // Sent by user
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.is_sender).toBe(1)
      expect(message.text).toBe('')
    })

    it('detects media messages with Type=49', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1003,
        CreateTime: 1700000002,
        Message: 'Hello',
        Type: 49, // Media type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })

    it('handles regular text messages correctly', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1004,
        CreateTime: 1700000003,
        Message: 'Hello world',
        Type: 1, // Text type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('text')
      expect(message.text).toBe('Hello world')
    })

    it('handles regular text messages with null content', () => {
      const row: WechatMessageRow = {
        msgSvrID: 1005,
        CreateTime: 1700000004,
        Message: null,
        Type: 1, // Text type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('other')
      expect(message.text).toBe(null)
    })
  })

  // WeChat 4.x schema test cases (V4)
  describe('WeChat 4.x schema image detection', () => {
    it('detects image messages with local_type=4 in V4', () => {
      const row: WechatMessageRow = {
        server_id: 2001,
        create_time: 1700000010,
        message_content: 'image data',
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 4, // Image type in V4
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })

    it('detects image messages with local_type=4 (sent by user) in V4', () => {
      const row: WechatMessageRow = {
        server_id: 2002,
        create_time: 1700000011,
        message_content: 'image data',
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 4, // Image type in V4
      }
      
      const message = mapMessage(row, 1, { selfWxid: 'test_user', senderIdMap: new Map([[1, 'test_user']]) })
      expect(message.type).toBe('image')
      expect(message.is_sender).toBe(1)
      expect(message.text).toBe('')
    })

    it('detects media messages with local_type=49 in V4 (if present)', () => {
      const row: WechatMessageRow = {
        server_id: 2003,
        create_time: 1700000012,
        message_content: 'media data',
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 49, // Media type in V4
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })

    it('handles text messages with local_type=1 in V4', () => {
      const row: WechatMessageRow = {
        server_id: 2004,
        create_time: 1700000013,
        message_content: 'Hello there',
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 1, // Text type in V4
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('text')
      expect(message.text).toBe('Hello there')
    })

    it('handles text messages with local_type=1 and null content in V4', () => {
      const row: WechatMessageRow = {
        server_id: 2005,
        create_time: 1700000014,
        message_content: null,
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 1, // Text type in V4
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('other')
      expect(message.text).toBe(null)
    })
  })

  // Mixed schema test cases
  describe('Mixed schema detection', () => {
    it('distinguishes between image and text messages in different schemas', () => {
      // Legacy schema image
      const legacyImageRow: WechatMessageRow = {
        msgSvrID: 3001,
        CreateTime: 1700000020,
        Message: 'image caption',
        Type: 4, // Image type
        Des: 1,
      }
      
      const legacyImage = mapMessage(legacyImageRow, 1)
      expect(legacyImage.type).toBe('image')
      expect(legacyImage.text).toBe('')
      
      // V4 schema image
      const v4ImageRow: WechatMessageRow = {
        server_id: 3002,
        create_time: 1700000021,
        message_content: 'image data',
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 4, // Image type in V4
      }
      
      const v4Image = mapMessage(v4ImageRow, 1)
      expect(v4Image.type).toBe('image')
      expect(v4Image.text).toBe('')
    })

    it('handles different message types correctly', () => {
      // Type 43 - Image (common in WeChat)
      const type43Row: WechatMessageRow = {
        msgSvrID: 4001,
        CreateTime: 1700000030,
        Message: 'image caption',
        Type: 43, // Image type
        Des: 1,
      }
      
      const type43 = mapMessage(type43Row, 1)
      expect(type43.type).toBe('image')
      expect(type43.text).toBe('')
      
      // Type 49 - Media (also used for images)
      const type49Row: WechatMessageRow = {
        msgSvrID: 4002,
        CreateTime: 1700000031,
        Message: 'media caption',
        Type: 49, // Media type
        Des: 1,
      }
      
      const type49 = mapMessage(type49Row, 1)
      expect(type49.type).toBe('image')
      expect(type49.text).toBe('')
    })
  })

  // Edge cases
  describe('Edge cases', () => {
    it('handles invalid or missing message types gracefully', () => {
      const row: WechatMessageRow = {
        msgSvrID: 5001,
        CreateTime: 1700000040,
        Message: 'some text',
        Type: 99, // Unknown type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('other')
      expect(message.text).toBe('some text')
    })

    it('handles empty string content for images', () => {
      const row: WechatMessageRow = {
        msgSvrID: 5002,
        CreateTime: 1700000041,
        Message: '',
        Type: 4, // Image type
        Des: 1,
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })

    it('handles undefined content for V4 images', () => {
      const row: WechatMessageRow = {
        server_id: 5003,
        create_time: 1700000042,
        message_content: undefined,
        WCDB_CT_message_content: 0,
        real_sender_id: 1,
        local_type: 4, // Image type in V4
      }
      
      const message = mapMessage(row, 1)
      expect(message.type).toBe('image')
      expect(message.text).toBe('')
    })
  })

  // Message type constants for reference
  describe('WeChat message type constants', () => {
    it('correctly identifies all image-related message types', () => {
      const imageTypes = [
        { Type: 4, description: 'Legacy image type' },
        { Type: 43, description: 'Image type in WeChat' },
        { Type: 49, description: 'Media type in WeChat' },
      ]
      
      for (const { Type, description } of imageTypes) {
        const row: WechatMessageRow = {
          msgSvrID: 6000 + Type,
          CreateTime: 1700000050,
          Message: 'test',
          Type,
          Des: 1,
        }
        
        const message = mapMessage(row, 1)
        expect(message.type).toBe('image', description)
        expect(message.text).toBe('')
      }
    })
  })
})