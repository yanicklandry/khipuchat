import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import * as sqliteVec from 'sqlite-vec'

describe('sqlite-vec smoke test', () => {
  it('sqliteVec.load() does not throw on better-sqlite3-multiple-ciphers', () => {
    const db = new Database(':memory:')
    expect(() => sqliteVec.load(db)).not.toThrow()
    db.close()
  })

  it('SELECT vec_version() returns a version string', () => {
    const db = new Database(':memory:')
    sqliteVec.load(db)
    const version = db.prepare('SELECT vec_version()').pluck().get() as string
    expect(typeof version).toBe('string')
    expect(version.length).toBeGreaterThan(0)
    db.close()
  })
})
