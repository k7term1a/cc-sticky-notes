import { describe, expect, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse, SessionMessage } from 'claude-code'

import type { Tree } from '../types'
import { readOptions, routePrompt, startNote } from '../hooks/notes'
import type { Ports } from '../hooks/ports'
import { ASK_OPTIONS } from '../hooks/route'
import { treeKey } from '../hooks/tree'

type Fake = {
  ports: Ports
  kv: Map<string, unknown>
  jevCalls: unknown[]
  forkPrompts: string[]
  toasts: string[]
  asked: number
  runLater(): Promise<void>
  tree(): Tree
  setSession(id: string): void
}

/** A Ports with everything in memory; Jev answers from `jev`, the fork echoes. */
function fake(opts: { jev?: (body: unknown) => unknown; typesafeKey?: string; askAnswer?: string } = {}): Fake {
  const kv = new Map<string, unknown>()
  const jevCalls: unknown[] = []
  const forkPrompts: string[] = []
  const toasts: string[] = []
  const queue: (() => void)[] = []
  let session = 'S1'
  let asked = 0
  const state = { lastTurnId: 't0' as string | null, turnsAt: 0, pending: 0, unread: 0 }
  const messages: SessionMessage[] = [
    { role: 'user', text: 'refactor auth to session cookies', toolUses: [] },
    { role: 'assistant', text: 'Done; token rotation remains.', toolUses: [] },
  ]
  const fetch = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    const body = JSON.parse(String(init?.body ?? '{}'))
    jevCalls.push(body)
    const answer = opts.jev?.(body)
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(answer) }
  }
  const ports: Ports = {
    sessionId: async () => session,
    projectRoot: async () => '/proj',
    turns: async () => 7,
    messages: async () => messages,
    now: async () => 1000,
    later: fn => void queue.push(fn),
    store: { get: async k => structuredClone(kv.get(k)), set: async (k, v) => void kv.set(k, structuredClone(v)) },
    fetch,
    fork: async prompt => {
      forkPrompts.push(prompt)
      return { isAnswered: true, text: `answer #${forkPrompts.length}`, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    },
    complete: async () => ({ isAnswered: true, text: '{"title":"標題","summary":"一。二。三。"}', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }),
    keys: { typesafe: async () => opts.typesafeKey, openai: async () => undefined },
    ui: {
      log: () => {},
      toast: t => void toasts.push(t),
      ask: async () => {
        asked++
        if (opts.askAnswer === undefined) throw new Error('dismissed')
        return opts.askAnswer
      },
      openPane: async () => {},
      closePane: async () => {},
      isPaneOpen: async () => false,
      suggest: async () => {},
    },
    state: {
      publishTree: async () => {},
      lastTurnId: async () => state.lastTurnId,
      turnsAtLastSidebar: async () => state.turnsAt,
      setTurnsAtLastSidebar: async n => void (state.turnsAt = n),
      addPending: async d => void (state.pending += d),
      addUnread: async d => void (state.unread += d),
    },
  }
  return {
    ports,
    kv,
    jevCalls,
    forkPrompts,
    toasts,
    get asked() {
      return asked
    },
    runLater: async () => {
      while (queue.length) {
        const fn = queue.shift()!
        fn()
        // answerNote is async; let its awaits settle
        for (let i = 0; i < 50; i++) await Promise.resolve()
      }
    },
    tree: () => kv.get(treeKey('/proj')) as Tree,
    setSession: id => void (session = id),
  }
}

const opts = readOptions({})

const jevSays = (route: string, confidence: number, isFollowup = 0, needsCtx = 1) => () => ({
  answers: {
    route: { type: 'choice', choice: route, confidence },
    is_followup: { type: 'noul', noul: isFollowup },
    needs_project_ctx: { type: 'noul', noul: needsCtx },
  },
})

describe('routePrompt', () => {
  test('without TYPESAFE_API_KEY it asks; a dismissed ask keeps the prompt in the main line', async () => {
    const f = fake()
    expect(await routePrompt(f.ports, opts, 'hi')).toEqual({ kind: 'main' })
    expect(f.asked).toBe(1)
    expect(f.jevCalls).toHaveLength(0)
  })

  test('without a key, choosing 旁支 in the ask makes a sidebar decision', async () => {
    const f = fake({ askAnswer: ASK_OPTIONS[1] })
    expect(await routePrompt(f.ports, opts, 'what is a monad')).toMatchObject({ kind: 'sidebar', attach: 'root', route: { source: 'ask' } })
  })

  test('with a key, Jev decides and receives the main-line context', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.9) })
    expect(await routePrompt(f.ports, opts, 'what is TCP backpressure')).toMatchObject({ kind: 'sidebar' })
    const state = (f.jevCalls[0] as { state: string }).state
    expect(state).toContain('refactor auth to session cookies')
    expect(state).toContain('[new prompt]\nwhat is TCP backpressure')
  })

  test('low Jev confidence falls back to the ask', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.4), askAnswer: ASK_OPTIONS[0] })
    expect(await routePrompt(f.ports, opts, 'x')).toEqual({ kind: 'main' })
    expect(f.asked).toBe(1)
  })
})

describe('notes end to end (stubbed fork and complete)', () => {
  const note = (f: Fake, question: string, attach: 'root' | 'followup') =>
    startNote(f.ports, opts, { question, attach: { kind: attach }, answerer: 'fork', route: { label: 'sidebar_knowledge', confidence: 0.9, source: 'jev' } })

  test('a note is stored at once and answered in the background', async () => {
    const f = fake()
    const id = await note(f, 'What is TCP backpressure?', 'root')
    expect(f.tree().nodes[id]?.answer).toBe('')
    expect(f.tree().nodes[id]?.anchor).toMatchObject({ sessionId: 'S1', turnId: 't0', mainSnippet: 'refactor auth to session cookies' })
    await f.runLater()
    expect(f.tree().nodes[id]).toMatchObject({ answer: 'answer #1', answeredBy: 'claude-fork', title: '標題', summary: '一。二。三。' })
    expect(f.toasts).toContain('📌 標題')
  })

  test('three follow-ups hang off the same thread and carry its history to the fork', async () => {
    const f = fake()
    const r = await note(f, 'Q-root', 'root')
    await f.runLater()
    const a = await note(f, 'Q-1', 'followup')
    await f.runLater()
    const b = await note(f, 'Q-2', 'followup')
    await f.runLater()
    const t = f.tree()
    expect(t.roots).toEqual([r])
    expect(t.nodes[b]?.parentId).toBe(a)
    expect(t.nodes[a]?.parentId).toBe(r)
    expect(f.forkPrompts[2]).toContain('Q1: Q-root\nA1: answer #1\nQ2: Q-1\nA2: answer #2')
  })

  test('a new non-follow-up question opens a new root', async () => {
    const f = fake()
    await note(f, 'first', 'root')
    await note(f, 'unrelated', 'root')
    expect(f.tree().roots).toHaveLength(2)
  })

  test('two sessions share one tree but keep their own activeThread', async () => {
    const f = fake()
    const a = await note(f, 'from S1', 'root')
    f.setSession('S2')
    const b = await note(f, 'from S2', 'followup')
    const t = f.tree()
    expect(t.nodes[b]?.parentId).toBeNull()
    expect(t.activeThread).toEqual({ S1: a, S2: b })
  })
})
