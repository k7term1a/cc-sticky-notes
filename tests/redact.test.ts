import { describe, expect, test } from 'claude-code/testing'

import { redact, REDACTED } from '../hooks/redact'

describe('redact (openaiContextMode=redacted)', () => {
  test('strips fenced code blocks whole', () => {
    expect(redact('before\n```ts\nconst x = 1\n```\nafter')).toBe(`before\n${REDACTED}\nafter`)
    expect(redact('open ```js\nnever closed')).toBe(`open ${REDACTED}`)
  })

  test('strips path-like tokens with an extension', () => {
    expect(redact('see src/auth/session.ts now')).toBe(`see ${REDACTED} now`)
    expect(redact('C:\\Users\\me\\proj\\main.py failed')).toBe(`${REDACTED} failed`)
    expect(redact('and/or is fine')).toBe('and/or is fine')
  })

  test('strips 20+ alphanumeric runs (keys, hashes)', () => {
    expect(redact('commit 9f2c4e1a7b3d5f6e8a9b0c1d2e3f4a5b6c7d8e9f')).toBe(`commit ${REDACTED}`)
    expect(redact('a short word stays')).toBe('a short word stays')
  })

  test('strips .env style assignments', () => {
    expect(redact('set OPENAI_API_KEY=sk-abc123 then')).toBe(`set ${REDACTED} then`)
    expect(redact('DATABASE_URL = postgres://u:p@h/db')).toBe(REDACTED)
  })

  test('leaves ordinary prose alone', () => {
    const s = '我們把 auth 改成 session cookie，剩下 token 輪替。'
    expect(redact(s)).toBe(s)
  })
})
