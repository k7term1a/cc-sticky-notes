import { describe, expect, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse, SessionMessage } from 'claude-code'

import type { RouteSample, Tree } from '../types'
import { listSamples } from '../hooks/feedback'
import { bookmarkNote, giveFeedback, readOptions, recordRoute, routePrompt, startNote, summaryProvider } from '../hooks/notes'
import type { KV, Ports } from '../hooks/ports'
import { ASK_OPTIONS } from '../hooks/route'
import { loadTree } from '../hooks/tree'

const ROOT = '/repo'

type Fake = {
  ports: Ports
  kv: KV
  jevCalls: unknown[]
  openaiCalls: number
  forkPrompts: string[]
  toasts: string[]
  logs: string[]
  asked: () => number
  runLater(): Promise<void>
  tree(): Promise<Tree>
  setSession(id: string): void
}

/** A Ports with everything in memory; Jev answers from `jev`, the fork echoes. */
function fake(opts: { jev?: (body: unknown) => unknown; typesafeKey?: string; openaiKey?: string; askAnswer?: string } = {}): Fake {
  const mem = new Map<string, string>()
  const kv: KV = {
    get: async k => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined),
    set: async (k, v) => void mem.set(k, JSON.stringify(v)),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
  const jevCalls: unknown[] = []
  const forkPrompts: string[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const queue: (() => void)[] = []
  let session = 'S1'
  let asked = 0
  let openaiCalls = 0
  let now = 1000
  const state = { lastTurnId: 't0' as string | null, turnsAt: 0, pending: 0, unread: 0, lastSample: null as string | null }
  const messages: SessionMessage[] = [
    { role: 'user', text: 'refactor auth to session cookies', toolUses: [] },
    { role: 'assistant', text: 'Done; token rotation remains.', toolUses: [] },
    // slash-command records are user messages too; they must not count as the main line
    { role: 'user', text: '<local-command-caveat>The command below was run directly…</local-command-caveat>', toolUses: [] },
    { role: 'user', text: '<command-name>/sticky-note</command-name>\n<command-args>doctor</command-args>', toolUses: [] },
  ]
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const fetch = async (url: string, init?: HttpInit): Promise<HttpResponse> => {
    if (url.includes('openai')) {
      openaiCalls++
      return { status: 200, ok: true, headers: {}, text: JSON.stringify({ choices: [{ message: { content: '{"title":"OA","summary":"x"}' } }], usage: { total_tokens: 9 } }) }
    }
    const body = JSON.parse(String(init?.body ?? '{}'))
    jevCalls.push(body)
    return { status: 200, ok: true, headers: {}, text: JSON.stringify(opts.jev?.(body)) }
  }
  const ports: Ports = {
    sessionId: async () => session,
    projectRoot: async () => ROOT,
    turns: async () => 7,
    messages: async () => messages,
    now: async () => ++now,
    later: fn => void queue.push(fn),
    store: kv,
    fetch,
    fork: async prompt => {
      forkPrompts.push(prompt)
      return { isAnswered: true, text: `answer #${forkPrompts.length}`, usage }
    },
    complete: async () => ({ isAnswered: true, text: '{"title":"標題","summary":"一。二。三。"}', usage }),
    keys: { typesafe: async () => opts.typesafeKey, openai: async () => opts.openaiKey, report: async () => [] },
    ui: {
      log: t => void logs.push(t),
      toast: t => void toasts.push(t),
      ask: async () => {
        asked++
        if (opts.askAnswer === undefined) throw new Error('dismissed')
        return opts.askAnswer
      },
      openPane: async () => {},
      closePane: async () => {},
      isPaneOpen: async () => false,
      status: () => {},
    },
    state: {
      publishTree: async () => {},
      lastTurnId: async () => state.lastTurnId,
      turnsAtLastSidebar: async () => state.turnsAt,
      setTurnsAtLastSidebar: async n => void (state.turnsAt = n),
      addPending: async d => void (state.pending += d),
      addUnread: async d => void (state.unread += d),
      lastPromptUuid: async () => 'msg-uuid-1',
      lastSampleId: async () => state.lastSample,
      setLastSampleId: async id => void (state.lastSample = id),
      setSelected: async () => {},
      toggleUiDemo: async () => false,
    },
  }
  return {
    ports,
    kv,
    jevCalls,
    get openaiCalls() {
      return openaiCalls
    },
    forkPrompts,
    toasts,
    logs,
    asked: () => asked,
    runLater: async () => {
      while (queue.length) {
        queue.shift()!()
        // answerNote is async; let its awaits settle
        for (let i = 0; i < 200; i++) await Promise.resolve()
      }
    },
    tree: () => loadTree(kv, ROOT),
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
  test('without TYPESAFE_API_KEY everything goes to the main line, with no dialog and no request', async () => {
    const f = fake()
    expect((await routePrompt(f.ports, opts, 'what is a monad')).decision).toEqual({ kind: 'main' })
    expect(f.asked()).toBe(0)
    expect(f.jevCalls).toHaveLength(0)
  })

  test('with a key, Jev decides and receives the main-line context', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.9) })
    expect((await routePrompt(f.ports, opts, 'what is TCP backpressure')).decision).toMatchObject({ kind: 'sidebar' })
    const state = (f.jevCalls[0] as { state: string }).state
    expect(state).toContain('refactor auth to session cookies')
    expect(state).not.toContain('command-name')
    expect(state).toContain('[new prompt]\nwhat is TCP backpressure')
  })

  test('low Jev confidence asks; the answer decides', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.4), askAnswer: ASK_OPTIONS[1] })
    const r = await routePrompt(f.ports, opts, 'x')
    expect(r.decision).toMatchObject({ kind: 'sidebar', attach: 'root' })
    expect(r.asked).toBe(ASK_OPTIONS[1])
  })

  test('a dismissed ask keeps the prompt in the main line', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.4) })
    expect((await routePrompt(f.ports, opts, 'x')).decision).toEqual({ kind: 'main' })
  })

  test('a Jev failure (bad JSON) also goes to the main line', async () => {
    const f = fake({ typesafeKey: 'k', jev: () => ({ nope: true }) })
    expect((await routePrompt(f.ports, opts, 'x')).decision).toEqual({ kind: 'main' })
    expect(f.asked()).toBe(0)
  })
})

describe('routing samples and feedback', () => {
  test('a Jev decision is kept; feedback marks it', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.65, 0.1, 0.69) })
    const routed = await routePrompt(f.ports, opts, '為什麼我們這裡用 session cookie？')
    await recordRoute(f.ports, opts, '為什麼我們這裡用 session cookie？', routed, 'node-1')
    expect(await giveFeedback(f.ports, { verdict: 'wrong', expected: 'project_question', source: 'command' })).toBe(true)
    const [s] = await listSamples(f.kv, ROOT)
    expect(s).toMatchObject({
      prompt: '為什麼我們這裡用 session cookie？',
      jev: { route: 'sidebar_knowledge', confidence: 0.65, needsProjectCtx: 0.69 },
      thresholds: { route: 0.6, followup: 0.6, needsCtx: 0.3 },
      decision: 'sidebar',
      nodeId: 'node-1',
      feedback: { verdict: 'wrong', expected: 'project_question', source: 'command' },
    } as Partial<RouteSample>)
  })

  test('when the user was asked, their answer is the label', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.4), askAnswer: ASK_OPTIONS[2] })
    const routed = await routePrompt(f.ports, opts, 'and then?')
    await recordRoute(f.ports, opts, 'and then?', routed, null)
    const [s] = await listSamples(f.kv, ROOT)
    expect(s).toMatchObject({ decision: 'ask', feedback: { verdict: 'right', expected: 'sidebar', source: 'ask' } })
  })

  test('without Jev nothing is kept, and feedback says there is nothing to mark', async () => {
    const f = fake()
    expect(await recordRoute(f.ports, opts, 'x', await routePrompt(f.ports, opts, 'x'), null)).toBeNull()
    expect(await listSamples(f.kv, ROOT)).toEqual([])
    expect(await giveFeedback(f.ports, { verdict: 'right', expected: null, source: 'command' })).toBe(false)
  })
})

describe('notes end to end (stubbed fork and complete)', () => {
  const note = (f: Fake, question: string, attach: 'root' | 'followup') =>
    startNote(f.ports, opts, { question, attach: { kind: attach }, answerer: 'fork', route: { label: 'sidebar_knowledge', confidence: 0.9, source: 'jev' } })

  test('a note is stored at once and answered in the background; the answer is logged (M1)', async () => {
    const f = fake()
    const id = await note(f, 'What is TCP backpressure?', 'root')
    expect((await f.tree()).nodes[id]?.answer).toBe('')
    expect((await f.tree()).nodes[id]?.anchor).toMatchObject({ sessionId: 'S1', turnId: 't0', messageId: 'msg-uuid-1', mainSnippet: 'refactor auth to session cookies' })
    await f.runLater()
    expect((await f.tree()).nodes[id]).toMatchObject({ answer: 'answer #1', answeredBy: 'claude-fork', title: '標題', summary: '一。二。三。' })
    expect(f.toasts).toContain('📌 標題')
    expect(f.logs.some(l => l.startsWith('📌 標題\nanswer #1'))).toBe(true)
  })

  test('three follow-ups hang off the same thread and carry its history to the fork', async () => {
    const f = fake()
    const r = await note(f, 'Q-root', 'root')
    await f.runLater()
    const a = await note(f, 'Q-1', 'followup')
    await f.runLater()
    const b = await note(f, 'Q-2', 'followup')
    await f.runLater()
    const t = await f.tree()
    expect(t.roots).toEqual([r])
    expect(t.nodes[b]?.parentId).toBe(a)
    expect(t.nodes[a]?.parentId).toBe(r)
    expect(f.forkPrompts[2]).toContain('Q1: Q-root\nA1: answer #1\nQ2: Q-1\nA2: answer #2')
  })

  test('two sessions share one tree but keep their own activeThread', async () => {
    const f = fake()
    const a = await note(f, 'from S1', 'root')
    f.setSession('S2')
    const b = await note(f, 'from S2', 'followup')
    const t = await f.tree()
    expect(t.nodes[b]?.parentId).toBeNull()
    expect(t.activeThread).toEqual({ S1: a, S2: b })
  })

  test('a project_question bookmark is promoted and never becomes activeThread', async () => {
    const f = fake()
    const a = await note(f, 'side', 'root')
    const bm = await bookmarkNote(f.ports, '為什麼我們這裡用 X？', { label: 'project_question', confidence: 0.9, source: 'jev' })
    const t = await f.tree()
    expect(t.activeThread.S1).toBe(a)
    expect(t.nodes[bm]).toMatchObject({ promotedIn: 'S1', answer: '' })
    expect(t.nodes[bm]?.promotedAt).not.toBeNull()
  })
})

describe('summary provider', () => {
  test('openai without a key falls back to claude, with one toast', async () => {
    const f = fake()
    const p = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai' }))
    const input = { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false }
    expect(await p.summarize('node-title-summary', input)).toMatchObject({ ok: true, provider: 'claude' })
    await p.summarize('node-title-summary', input)
    expect(f.toasts.filter(t => t.includes('OPENAI_API_KEY'))).toHaveLength(1)
  })

  test('openai with a key sends reasoning_effort from the config', async () => {
    let body: Record<string, unknown> = {}
    const f = fake({ openaiKey: 'k' })
    const fetch = f.ports.fetch
    f.ports.fetch = async (url, init) => {
      if (url.includes('openai')) body = JSON.parse(String(init?.body))
      return fetch(url, init)
    }
    const p = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai', openaiReasoningEffort: 'low' }))
    expect(await p.summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })).toMatchObject({ ok: true, provider: 'openai' })
    expect(body.reasoning_effort).toBe('low')
    const q = summaryProvider(f.ports, readOptions({ summaryProvider: 'openai', openaiReasoningEffort: 'none' }))
    await q.summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })
    expect('reasoning_effort' in body).toBe(false)
  })

  test('claudeModel and claudeEffort reach $.model.complete', async () => {
    const f = fake()
    let seen: unknown = null
    f.ports.complete = async req => {
      seen = req
      return { isAnswered: true, text: 'x', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
    }
    await summaryProvider(f.ports, readOptions({ claudeModel: 'sonnet', claudeEffort: 'medium' })).summarize('tag-name', { system: 's', prompt: 'p', maxTokens: 10, hasProjectContent: false })
    expect(seen).toMatchObject({ model: 'sonnet', effort: 'medium' })
  })
})
