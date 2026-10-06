import { describe, expect, test } from 'claude-code/testing'

import { buildForkPrompt } from '../hooks/answer'
import { parseTitleSummary } from '../hooks/digest'
import { buildRequest, buildState, classify, NEW_TAG, parseResponse, type JevInput } from '../hooks/jev'

const input = (over: Partial<JevInput> = {}): JevInput => ({
  recentUser: ['u1', 'u2', 'u3', 'u4'],
  lastAssistant: 'a'.repeat(400),
  activeTitle: null,
  activeLastQuestion: null,
  mainTurnsSinceLastSidebar: 3,
  prompt: '為什麼 TCP 要三次握手？',
  tags: [],
  ...over,
})

describe('jev request', () => {
  test('state keeps the last 3 user prompts and clips the reply to 300 chars', () => {
    const s = buildState(input())
    expect(s).not.toContain('user: u1')
    expect(s).toContain('user: u4')
    expect(s).toContain(`assistant: ${'a'.repeat(300)}…`)
    expect(s).toContain('active_thread_title: none')
    expect(s).toContain('main_turns_since_last_sidebar: 3')
    expect(s.endsWith('[new prompt]\n為什麼 TCP 要三次握手？')).toBe(true)
  })

  test('the tag question appears only when tags exist, with __new__', () => {
    const none = buildRequest(input()) as { questions: Record<string, unknown> }
    expect(none.questions.tag).toBeUndefined()
    const some = buildRequest(input({ tags: ['db'] })) as { questions: { tag: { criteria: Record<string, string> } } }
    expect(Object.keys(some.questions.tag.criteria)).toEqual(['db', NEW_TAG])
  })
})

describe('jev response', () => {
  const ok = {
    answers: {
      route: { type: 'choice', choice: 'sidebar_knowledge', confidence: 0.91, probabilities: {} },
      is_followup: { type: 'noul', noul: 0.2 },
      needs_project_ctx: { type: 'noul', noul: 0.7 },
    },
  }

  test('parses the documented shape', () => {
    expect(parseResponse(ok)).toEqual({ route: { label: 'sidebar_knowledge', confidence: 0.91 }, isFollowup: 0.2, needsProjectCtx: 0.7 })
  })

  test('rejects unknown routes and missing answers', () => {
    expect(parseResponse({ answers: { ...ok.answers, route: { type: 'choice', choice: 'other', confidence: 1 } } })).toBeNull()
    expect(parseResponse({})).toBeNull()
    expect(parseResponse(null)).toBeNull()
  })

  test('classify without a key reports no-key and never fetches', async () => {
    let fetched = 0
    const r = await classify({ key: undefined, fetch: async () => { fetched++; throw new Error('no') }, now: async () => 0 }, input())
    expect(r).toMatchObject({ ok: false, reason: 'no-key' })
    expect(fetched).toBe(0)
  })

  test('classify sends a bearer key and maps a 403 to http', async () => {
    let auth = ''
    const r = await classify(
      {
        key: 'k',
        fetch: async (_u, init) => {
          auth = (init?.headers as Record<string, string>).authorization ?? ''
          return { status: 403, ok: false, headers: {}, text: '{"detail":{}}' }
        },
        now: async () => 0,
      },
      input(),
    )
    expect(auth).toBe('Bearer k')
    expect(r).toMatchObject({ ok: false, reason: 'http', status: 403 })
  })
})

describe('summary + fork prompts', () => {
  test('title/summary JSON, fenced or bare', () => {
    expect(parseTitleSummary('```json\n{"title":"TCP 背壓","summary":"a. b. c."}\n```')).toEqual({ title: 'TCP 背壓', summary: 'a. b. c.' })
    expect(parseTitleSummary('nope')).toBeNull()
  })

  test('the fork prompt carries the side thread as text', () => {
    const p = buildForkPrompt([{ question: 'Q?', answer: 'A.' }], 'Next?')
    expect(p).toContain('Q1: Q?\nA1: A.')
    expect(p.endsWith('[question]\nNext?')).toBe(true)
  })
})
