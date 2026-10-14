import { describe, expect, test } from 'claude-code/testing'
import type { HttpInit, HttpResponse, SessionMessage } from 'claude-code'

import type { FeedbackRecord, Tree } from '../types'
import { listRecords } from '../hooks/feedback'
import { addFacts, digestDue, digestInput, lastExchanges, parseDigest, readDigest, readFacts } from '../hooks/context'
import { runCommand } from '../hooks/commands'
import { notionServer, projectName } from '../hooks/notion'
import { applyOptionOverrides, syncPull, syncPushAll, digestNow, digestWords, explainDrop, giveFeedback, plainPreview, readOptions, recordFeedback, routePrompt, startNote, summaryProvider } from '../hooks/notes'
import { addUsage, claudeDelta, fetchDelta, readUsage, shortCount, usageKey, usageLine } from '../hooks/usage'
import type { KV, Ports } from '../hooks/ports'
import { MAIN_LABEL, NEW_NOTE_LABEL, OTHER_NOTE_LABEL } from '../hooks/route'
import { loadTree } from '../hooks/tree'

const ROOT = '/repo'

type Fake = {
  ports: Ports
  kv: KV
  jevCalls: unknown[]
  openaiCalls: number
  openaiBodies: string[]
  contextChanges: () => number
  digestRuns: { running: boolean; result: string | null }[]
  options: Record<string, unknown>
  forkPrompts: string[]
  toasts: string[]
  logs: string[]
  asked: () => number
  lastAsk: () => { question: string; options: string[] } | null
  asks: () => { question: string; options: string[] }[]
  opened: () => number
  runLater(): Promise<void>
  tree(): Promise<Tree>
  setSession(id: string): void
}

/** A Ports with everything in memory; Jev answers from `jev`, the fork echoes. */
/** A Notion database in memory, shared by fakes that stand for two computers. */
type FakeNotion = { rows: Record<string, unknown>[]; bodies: Map<string, string> }
const newNotion = (): FakeNotion => ({ rows: [], bodies: new Map() })

function fake(opts: { jev?: (body: unknown) => unknown; typesafeKey?: string; openaiKey?: string; askAnswer?: string | string[]; notion?: FakeNotion; machine?: string; remote?: string | null } = {}): Fake {
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
  let lastAsk: { question: string; options: string[] } | null = null
  const asks: { question: string; options: string[] }[] = []
  const answers = Array.isArray(opts.askAnswer) ? [...opts.askAnswer] : null
  let openaiCalls = 0
  let opened = 0
  let contextChanges = 0
  const digestRuns: { running: boolean; result: string | null }[] = []
  const openaiBodies: string[] = []
  const options: Record<string, unknown> = {}
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
      openaiBodies.push(String(init?.body ?? ''))
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
    // the digest's own system prompt asks for {"digest", "facts"}; every other job for a title
    complete: async req => ({
      isAnswered: true,
      text: String(req.system ?? '').includes('"digest"') ? '{"digest":"主線在把 auth 改成 session cookie。","facts":["我們用 session cookie，不用 JWT"]}' : '{"title":"標題","summary":"一。二。三。"}',
      usage,
    }),
    setOption: async (field, value) => ((options[field] = value), { ok: true }),
    place: async () => ({ remote: opts.remote === undefined ? 'git@github.com:me/proj.git' : opts.remote, machine: opts.machine ?? 'HOME' }),
    mcp: {
      tools: async () => (opts.notion ? ['mcp__srv__notion-fetch', 'mcp__srv__notion-create-pages'] : []),
      call: async (server, tool, args) => {
        const db = opts.notion
        if (!db || server !== 'srv') return { isError: true, content: [{ type: 'text', text: 'no server' }] }
        const text = (t: string) => ({ isError: false, content: [{ type: 'text', text: t }] })
        if (tool === 'notion-create-pages') {
          const page = (args.pages as { properties: Record<string, unknown>; content: string }[])[0]!
          const url = `https://app.notion.com/p/${db.rows.length + 1}`
          db.rows.push({ ...page.properties, url })
          db.bodies.set(url, page.content)
          return text(`Created page ${url}`)
        }
        if (tool === 'notion-query-data-sources') {
          const filters = ((args.data as { filter: { filters: { property: string; value: { value: string } }[] } }).filter.filters)
          const project = filters.find(x => x.property === '專案')!.value.value
          return text(JSON.stringify({ results: db.rows.filter(r => r['專案'] === project), has_more: false }))
        }
        if (tool === 'notion-fetch') return text(JSON.stringify({ text: `<page>\n<content>\n${db.bodies.get(String(args.id)) ?? ''}\n</content>\n</page>` }))
        return { isError: true, content: [] }
      },
    },
    keys: { typesafe: async () => opts.typesafeKey, openai: async () => opts.openaiKey, report: async () => [] },
    ui: {
      log: t => void logs.push(t),
      toast: t => void toasts.push(t),
      ask: async (question, options) => {
        asked++
        lastAsk = { question, options: [...options] }
        asks.push(lastAsk)
        const a = answers ? answers.shift() : (opts.askAnswer as string | undefined)
        if (a === undefined) throw new Error('dismissed')
        return a
      },
      openPane: async () => void opened++,
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
      contextChanged: async () => void contextChanges++,
      setDigestStatus: async (running, result) => void digestRuns.push({ running, result }),
    },
  }
  return {
    ports,
    kv,
    jevCalls,
    get openaiCalls() {
      return openaiCalls
    },
    openaiBodies,
    contextChanges: () => contextChanges,
    digestRuns,
    options,
    forkPrompts,
    toasts,
    logs,
    asked: () => asked,
    lastAsk: () => lastAsk,
    asks: () => asks,
    opened: () => opened,
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

describe('routePrompt: Jev never makes a note by itself', () => {
  test('without TYPESAFE_API_KEY everything goes to the main line, with no dialog and no request', async () => {
    const f = fake()
    expect((await routePrompt(f.ports, opts, 'what is a monad')).decision).toEqual({ kind: 'main' })
    expect(f.asked()).toBe(0)
    expect(f.jevCalls).toHaveLength(0)
  })

  test('a confident main_task goes through without a dialog; Jev gets the main-line context', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.9) })
    expect(await routePrompt(f.ports, opts, 'fix the login bug')).toMatchObject({ decision: { kind: 'main' }, asked: false })
    expect(f.asked()).toBe(0)
    const state = (f.jevCalls[0] as { state: string }).state
    expect(state).toContain('refactor auth to session cookies')
    expect(state).toContain('[new prompt]\nfix the login bug')
  })

  test('sidebar_knowledge always asks, even at 99%; picking 開新的便利貼 makes a root note', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.99), askAnswer: NEW_NOTE_LABEL })
    const r = await routePrompt(f.ports, opts, 'what is TCP backpressure')
    expect(f.lastAsk()).toEqual({ question: '這句要怎麼處理？(Jev：知識旁問 99%)', options: [NEW_NOTE_LABEL, MAIN_LABEL] })
    expect(r).toMatchObject({ asked: true, choice: 'new', decision: { kind: 'sidebar', attach: 'root', route: { label: 'new', confidence: 0.99, source: 'ask' } } })
  })

  test('a low-confidence main_task asks too; 送進主線 goes to the main line', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.32), askAnswer: MAIN_LABEL })
    const r = await routePrompt(f.ports, opts, 'x')
    expect(f.lastAsk()?.question).toBe('這句要怎麼處理？(Jev：主線任務 32%)')
    expect(r).toMatchObject({ asked: true, choice: 'main', decision: { kind: 'main' } })
  })

  test('with an active thread the dialog offers it, ordered by is_followup', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.9, 0.8), askAnswer: '接在「What is CRDT」下' })
    await startNote(f.ports, opts, { question: 'What is CRDT about?', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    const r = await routePrompt(f.ports, opts, 'and conflicts?')
    expect(f.lastAsk()?.options).toEqual(['接在「What is CRDT」下', NEW_NOTE_LABEL, MAIN_LABEL])
    expect(r).toMatchObject({ choice: 'followup', decision: { kind: 'sidebar', attach: 'followup' } })
  })

  test('a Remote Control prompt never gets the dialog: where it would ask, it goes to the main line', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.99), askAnswer: NEW_NOTE_LABEL })
    expect(await routePrompt(f.ports, opts, 'what is TCP backpressure', { remote: true })).toMatchObject({ decision: { kind: 'main' }, asked: false, choice: null })
    expect(f.asked()).toBe(0)
    // Jev still ran, so a confident project question still gets its context line
    const g = fake({ typesafeKey: 'k', jev: jevSays('project_question', 0.9) })
    expect((await routePrompt(g.ports, opts, '我們這裡為什麼用 cookie', { remote: true })).decision).toMatchObject({ kind: 'project_question' })
  })

  test('a dismissed dialog keeps the prompt in the main line', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.9) })
    expect(await routePrompt(f.ports, opts, 'x')).toMatchObject({ decision: { kind: 'main' }, asked: true, choice: null })
  })

  test('a Jev failure (bad JSON) also goes to the main line, no dialog', async () => {
    const f = fake({ typesafeKey: 'k', jev: () => ({ nope: true }) })
    expect((await routePrompt(f.ports, opts, 'x')).decision).toEqual({ kind: 'main' })
    expect(f.asked()).toBe(0)
  })
})

describe('which note a follow-up goes under (R6)', () => {
  const twoNotes = async (f: Fake) => {
    const a = await startNote(f.ports, opts, { question: 'What is CRDT about?', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    const b = await startNote(f.ports, opts, { question: 'TCP backpressure?', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await f.runLater()
    return { a, b } // b is this session's activeThread
  }
  const jevPick = (key: string, confidence: number, probabilities: Record<string, number> = {}) => () => ({
    answers: {
      route: { type: 'choice', choice: 'sidebar_knowledge', confidence: 0.9 },
      is_followup: { type: 'noul', noul: 0.1 },
      needs_project_ctx: { type: 'noul', noul: 1 },
      continues: { type: 'choice', choice: key, confidence, probabilities },
    },
  })

  test('Jev is asked which recent note the prompt continues, the activeThread listed first', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevPick('none', 0.9) })
    await twoNotes(f)
    await routePrompt(f.ports, opts, 'x').catch(() => {})
    const criteria = (f.jevCalls.at(-1) as { questions: { continues: { criteria: Record<string, string> } } }).questions.continues.criteria
    expect(Object.keys(criteria)).toEqual(['n1', 'n2', 'none'])
    expect(criteria.n1).toContain('標題') // the activeThread (b), titled by the summary stub
  })

  test("the dialog offers the note Jev picked, not the activeThread, and the follow-up goes under it", async () => {
    const f = fake({ typesafeKey: 'k', jev: jevPick('n2', 0.8), askAnswer: '接在「標題」下' })
    const { a } = await twoNotes(f)
    const r = await routePrompt(f.ports, opts, 'and conflicts?')
    expect(f.lastAsk()?.options).toEqual(['接在「標題」下', NEW_NOTE_LABEL, MAIN_LABEL, OTHER_NOTE_LABEL])
    expect(r).toMatchObject({ choice: 'followup', decision: { kind: 'sidebar', attach: 'followup', parentId: a } })
  })

  test('〔接在其他便利貼下…〕 asks again with the other notes, and the pick is the parent', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevPick('none', 0.9), askAnswer: [OTHER_NOTE_LABEL, '「標題」'] })
    const { a } = await twoNotes(f)
    const r = await routePrompt(f.ports, opts, 'and conflicts?')
    expect(f.asks()).toHaveLength(2)
    expect(f.asks()[1]!.options).toEqual(['「標題」', MAIN_LABEL])
    expect(r).toMatchObject({ choice: 'followup', decision: { parentId: a } })
  })

  test('text under "Other" finds a note by its words; nothing found goes to the main line with a toast', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevPick('none', 0.9), askAnswer: 'crdt' })
    const { a } = await twoNotes(f)
    expect(await routePrompt(f.ports, opts, 'and conflicts?')).toMatchObject({ choice: 'followup', decision: { parentId: a } })
    const g = fake({ typesafeKey: 'k', jev: jevPick('none', 0.9), askAnswer: '量子' })
    await twoNotes(g)
    expect(await routePrompt(g.ports, opts, 'x')).toMatchObject({ choice: null, decision: { kind: 'main' } })
    expect(g.toasts.some(t => t.includes('找不到「量子」'))).toBe(true)
  })
})

describe('feedback records (feedback:<root>:<id>)', () => {
  test('every prompt Jev saw is kept with its call, its confidence and the choice', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('sidebar_knowledge', 0.65, 0.1, 0.69), askAnswer: NEW_NOTE_LABEL })
    const routed = await routePrompt(f.ports, opts, '為什麼我們這裡用 session cookie？')
    await recordFeedback(f.ports, opts, '為什麼我們這裡用 session cookie？', routed, 'node-1')
    const [r] = await listRecords(f.kv, ROOT)
    expect(r).toMatchObject({
      prompt: '為什麼我們這裡用 session cookie？',
      jev: { route: 'sidebar_knowledge', confidence: 0.65, needsProjectCtx: 0.69 },
      thresholds: { route: 0.6, followup: 0.6, needsCtx: 0.3 },
      asked: true,
      outcome: 'new',
      choice: 'new',
      choiceSource: 'ask',
      nodeId: 'node-1',
    } as Partial<FeedbackRecord>)
    expect((await f.kv.keys()).some(k => k.startsWith(`feedback:${ROOT}:`))).toBe(true)
  })

  test('a main_task Jev let through has no choice until /sn feedback says one', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.9) })
    await recordFeedback(f.ports, opts, 'what is a monad', await routePrompt(f.ports, opts, 'what is a monad'), null)
    expect((await listRecords(f.kv, ROOT))[0]).toMatchObject({ asked: false, outcome: 'main', choice: null, choiceSource: null })
    expect(await giveFeedback(f.ports, { choice: 'new' })).toMatchObject({ choice: 'new', choiceSource: 'command' })
    expect(await giveFeedback(f.ports, { good: true })).toMatchObject({ choice: 'main' }) // good = what happened
  })

  test('without Jev nothing is kept, and feedback has nothing to mark', async () => {
    const f = fake()
    expect(await recordFeedback(f.ports, opts, 'x', await routePrompt(f.ports, opts, 'x'), null)).toBeNull()
    expect(await listRecords(f.kv, ROOT)).toEqual([])
    expect(await giveFeedback(f.ports, { good: true })).toBeNull()
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
    expect(f.toasts).toContain('cc-sticky-note 標題')
    expect(f.opened()).toBe(1) // autoOpenPane is on by default
    expect(f.logs).toContain('cc-sticky-note 標題：一。二。三。　/sn 看完整答案')
    expect([...f.toasts, ...f.logs].join('')).not.toMatch(/\p{Extended_Pictographic}/u)
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
})

describe('R4: the main-line digest and the project context', () => {
  test('due every digestEvery turns; 0 turns it off', () => {
    expect(digestDue(3, 3, null)).toBe(true)
    expect(digestDue(3, 2, null)).toBe(false)
    expect(digestDue(3, 5, { text: 'x', turns: 3, at: 0 })).toBe(false)
    expect(digestDue(3, 6, { text: 'x', turns: 3, at: 0 })).toBe(true)
    expect(digestDue(0, 99, null)).toBe(false)
    expect(readOptions({}).digestEvery).toBe(3)
  })

  test('digestNow: forced, then not due until digestEvery more turns', async () => {
    const f = fake({ typesafeKey: 'k', jev: jevSays('main_task', 0.9) })
    expect(await digestNow(f.ports, opts, true)).toBe('digest written, 1 new fact(s)')
    expect(await digestNow(f.ports, opts)).toBe('not due')
    expect(await readDigest(f.kv, ROOT, 'S1')).toMatchObject({ text: '主線在把 auth 改成 session cookie。', turns: 7 })
    // the same fact again is not added twice
    expect(await digestNow(f.ports, opts, true)).toBe('digest written')
    expect((await readFacts(f.kv, ROOT)).map(x => x.text)).toEqual(['我們用 session cookie，不用 JWT'])
    expect(f.contextChanges()).toBe(2)
    // the card saw each run start and end, in words
    expect(f.digestRuns).toEqual([
      { running: true, result: null },
      { running: false, result: '完成，新增 1 條脈絡' },
      { running: true, result: null },
      { running: false, result: '完成，沒有新的脈絡' },
    ])
    expect(digestWords('no exchanges')).toBe('沒有統整：主線還沒有對話')
    // Jev reads the digest and the facts
    await routePrompt(f.ports, opts, 'fix the login bug')
    const state = (f.jevCalls.at(-1) as { state: string }).state
    expect(state).toContain('[main-line digest]\n主線在把 auth 改成 session cookie。')
    expect(state).toContain('- 我們用 session cookie，不用 JWT')
  })

  test('the digest reads the last exchanges: each typed prompt with the reply after it', () => {
    const msgs = [
      { role: 'user', text: 'u1' },
      { role: 'assistant', text: 'a1' },
      { role: 'user', text: '<command-name>/sn</command-name>' },
      { role: 'user', text: 'u2' },
      { role: 'assistant', text: '' },
      { role: 'assistant', text: 'a2' },
    ]
    const isTyped = (m: { role: string; text: string }) => m.role === 'user' && !m.text.startsWith('<')
    expect(lastExchanges(msgs, isTyped)).toEqual([
      { user: 'u1', assistant: 'a1' },
      { user: 'u2', assistant: 'a2' },
    ])
  })

  test('the first run reads the whole session; later runs the exchanges since the last one', () => {
    const all = Array.from({ length: 8 }, (_, i) => ({ user: `u${i + 1}`, assistant: `a${i + 1}` }))
    // no digest yet: every earlier prompt, and the last three in detail
    expect(digestInput(all, null, 3)).toEqual({ earlier: ['u1', 'u2', 'u3', 'u4', 'u5'], exchanges: all.slice(-3) })
    // a digest kept at 5 prompts: the 3 since
    expect(digestInput(all, { text: 'd', turns: 5, prompts: 5, at: 0 }, 3)).toEqual({ earlier: [], exchanges: all.slice(5) })
    // a compaction shortened the transcript under the kept count: the last `every`
    expect(digestInput(all.slice(0, 2), { text: 'd', turns: 9, prompts: 9, at: 0 }, 3).exchanges).toEqual(all.slice(0, 2))
    // an old digest without the count: the last `every`
    expect(digestInput(all, { text: 'd', turns: 5, at: 0 }, 2).exchanges).toEqual(all.slice(-2))
  })

  test('facts: malformed answers are no digest; over the cap the oldest automatic facts go, hand-added ones stay', () => {
    expect(parseDigest('nope')).toBeNull()
    expect(parseDigest('{"digest":"d","facts":["a","b","c","d"]}')).toEqual({ digest: 'd', facts: ['a', 'b', 'c'] })
    const fact = (i: number, source: 'auto' | 'manual') => ({ id: String(i), text: `f${i}`, at: i, sessionId: 'S', source })
    const list = [fact(0, 'manual'), ...Array.from({ length: 59 }, (_, i) => fact(i + 1, 'auto'))]
    const next = addFacts(list, [fact(100, 'auto'), fact(101, 'auto')])
    expect(next).toHaveLength(60)
    expect(next[0]!.source).toBe('manual')
    expect(next.map(x => x.id)).not.toContain('1')
    expect(next.at(-1)!.id).toBe('101')
  })

  test('/sn every and /sn provider write the plugin setting and take effect at once', async () => {
    const f = fake()
    const o = readOptions({})
    await runCommand(f.ports, o, 'every 5')
    expect(f.options.digestEvery).toBe(5)
    expect(o.digestEvery).toBe(5)
    expect(await runCommand(f.ports, o, 'every -1')).toMatchObject({ text: expect.stringContaining('用法') })
    await runCommand(f.ports, o, 'provider openai')
    expect(f.options.summaryProvider).toBe('openai')
    expect(o.summaryProvider).toBe('openai')
    expect(await runCommand(f.ports, o, 'provider')).toMatchObject({ text: expect.stringContaining('OpenAI') })
  })

  test('/sn ctx add and rm edit the project context', async () => {
    const f = fake()
    await runCommand(f.ports, opts, 'ctx add 部署前要先跑 migration')
    await runCommand(f.ports, opts, 'ctx add 測試用 bun')
    expect((await readFacts(f.kv, ROOT)).map(x => [x.text, x.source])).toEqual([
      ['部署前要先跑 migration', 'manual'],
      ['測試用 bun', 'manual'],
    ])
    await runCommand(f.ports, opts, 'ctx rm 1')
    expect((await readFacts(f.kv, ROOT)).map(x => x.text)).toEqual(['測試用 bun'])
    expect(await runCommand(f.ports, opts, 'ctx rm 9')).toMatchObject({ text: expect.stringContaining('用法') })
  })

  test('OpenAI with openaiContextMode=redacted gets the digest input stripped', async () => {
    const f = fake({ openaiKey: 'k' })
    const o = { ...readOptions({ summaryProvider: 'openai' }) }
    await summaryProvider(f.ports, o).summarize('main-digest', { system: 's', prompt: '看 src/auth/session.ts\n```ts\nconst SECRET = 1\n```', maxTokens: 10, hasProjectContent: true })
    const body = f.openaiBodies.at(-1)!
    expect(body).not.toContain('src/auth/session.ts')
    expect(body).not.toContain('const SECRET')
    expect(body).toContain('[redacted]')
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

describe('status line: what the mod spent today (no emoji, no plugin name: Desktop draws it)', () => {
  test('Jev calls and Claude tokens; OpenAI once used; the pending answers', () => {
    const u = { jev: 12, claude: 34567, claudeCacheRead: 900000, openai: 0 }
    expect(usageLine(u, 0)).toBe('今日 Jev 12 次 · Claude 35k')
    expect(usageLine({ ...u, openai: 1234 }, 2)).toBe('今日 Jev 12 次 · Claude 35k · OpenAI 1.2k · 2 則回答中')
    expect(usageLine(u, 1)).not.toMatch(/\p{Extended_Pictographic}|cc-sticky/u)
    expect([shortCount(999), shortCount(1000), shortCount(9949), shortCount(10500)]).toEqual(['999', '1.0k', '9.9k', '11k'])
  })

  test('counted per local day: Jev by URL, OpenAI by total_tokens, Claude without cache reads', async () => {
    const f = fake()
    const day = new Date(2026, 9, 14, 23, 59)
    expect(usageKey(day)).toBe('usage:2026-10-14')
    await addUsage(f.kv, day, fetchDelta('https://api.typesafe.ai/v1/systemone', null))
    await addUsage(f.kv, day, fetchDelta('https://api.openai.com/v1/chat/completions', { status: 200, ok: true, headers: {}, text: '{"usage":{"total_tokens":150}}' }))
    await addUsage(f.kv, day, claudeDelta({ input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 40000 }))
    expect(await readUsage(f.kv, day)).toEqual({ jev: 1, claude: 35, claudeCacheRead: 40000, openai: 150 })
    expect(await readUsage(f.kv, new Date(2026, 9, 15, 0, 1))).toEqual({ jev: 0, claude: 0, claudeCacheRead: 0, openai: 0 })
    expect(fetchDelta('https://example.com', null)).toEqual({})
  })
})

describe('the drop line and the log preview', () => {
  const v = (confidence: number) => ({ route: { label: 'sidebar_knowledge' as const, confidence }, isFollowup: 0, needsProjectCtx: 0 })
  const note = (attach: 'root' | 'followup') => ({
    kind: 'sidebar' as const,
    attach,
    answerer: 'fork' as const,
    tag: { kind: 'none' as const },
    route: { label: attach === 'root' ? 'new' : 'followup', confidence: 0.9, source: 'ask' as const },
  })

  test('the drop reason says where the note went (every note is the user pick)', () => {
    expect(explainDrop('CRDT 是什麼？', { decision: note('root'), verdict: v(0.95), asked: true, choice: 'new', parentTitle: null })).toBe('cc-sticky-note：新的便利貼「CRDT 是什麼？」')
    expect(explainDrop('那衝突怎麼解？', { decision: note('followup'), verdict: v(0.88), asked: true, choice: 'followup', parentTitle: 'CRDT無衝突複製' })).toBe(
      'cc-sticky-note：接在「CRDT無衝突複製」下「那衝突怎麼解？」',
    )
  })

  test('the log preview is one plain line, no Markdown marks', () => {
    const md = [
      '# CRDT（Conflict-free）',
      'CRDT 是一種**無衝突**資料型別。',
      '## 核心特性',
      '- **無衝突**：多個副本',
      '| 型別 | 用途 |',
      '|------|------|',
      '| 計數器 | 遞增 |',
    ].join('\n')
    const p = plainPreview(md, 200)
    expect(p).not.toMatch(/[#*|]/)
    expect(p.startsWith('CRDT（Conflict-free） CRDT 是一種 無衝突 資料型別。')).toBe(true)
    expect([...plainPreview(md, 10)]).toHaveLength(11) // 10 + …
  })

  test('the drop reason quotes at most 24 characters of the question', () => {
    const long = '為什麼分散式系統裡的 CRDT 可以不靠中央伺服器就讓所有副本最後一致？'
    expect(explainDrop(long, { decision: note('root'), verdict: v(0.9), asked: true, choice: 'new', parentTitle: null })).toBe(
      `cc-sticky-note：新的便利貼「${[...long].slice(0, 24).join('')}…」`,
    )
  })
})

describe('Notion sync: finding the connector', () => {
  test('the server is the part of a notion-fetch tool name between mcp__ and __', () => {
    expect(notionServer(['mcp__x__other', 'mcp__c20941de-f53b-4587-a934-6b80ec468eea__notion-fetch'])).toBe('c20941de-f53b-4587-a934-6b80ec468eea')
    expect(notionServer(['mcp__x__other'])).toBeNull()
  })

  test('/sn notion takes a collection:// URL into the setting; test needs one first', async () => {
    const f = fake()
    const o = readOptions({})
    expect(await runCommand(f.ports, o, 'notion test')).toMatchObject({ text: expect.stringContaining('還沒設定') })
    expect(await runCommand(f.ports, o, 'notion https://example.com')).toMatchObject({ text: expect.stringContaining('用法') })
    await runCommand(f.ports, o, 'notion collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    expect(f.options.notionDataSource).toBe('collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    expect(await runCommand(f.ports, o, 'notion test')).toMatchObject({ text: expect.stringContaining('找不到 Notion connector') })
  })
})

describe('per-machine settings (/sn provider, every, notion)', () => {
  test('the store\'s values go over the plugin settings at session start', async () => {
    const f = fake()
    await f.kv.set('option:summaryProvider', 'openai')
    await f.kv.set('option:digestEvery', 0)
    await f.kv.set('option:notionDataSource', 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70')
    await f.kv.set('option:junk', 'x')
    const o = readOptions({ summaryProvider: 'claude', digestEvery: 3 })
    await applyOptionOverrides(f.kv, o)
    expect([o.summaryProvider, o.digestEvery, o.notionDataSource]).toEqual(['openai', 0, 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70'])
  })
})

describe('Notion sync between computers', () => {
  test('a project is named by its git remote, the same on every computer', () => {
    expect(projectName('git@github.com:K7term1a/cc-sticky-notes.git', 'c:/x')).toBe('github.com/k7term1a/cc-sticky-notes')
    expect(projectName('https://github.com/k7term1a/cc-sticky-notes.git', '/Users/kaichi/cc-sticky-notes')).toBe('github.com/k7term1a/cc-sticky-notes')
    expect(projectName(null, 'c:/Users/kay13/desktop/proj')).toBe('proj')
  })

  test('home answers and pushes a thread; the laptop pulls it in once, follow-up under its parent', async () => {
    const notion = newNotion()
    const o = { ...readOptions({}), notionDataSource: 'collection://8e59b59f-189a-443c-9c5b-083b5766ac70' }
    const home = fake({ notion, machine: 'HOME' })
    const root = await startNote(home.ports, o, { question: 'CRDT 是什麼？', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await home.runLater()
    const child = await startNote(home.ports, o, { question: '衝突怎麼合併？', attach: { kind: 'under', parentId: root }, answerer: 'fork', route: { label: 'followup', confidence: 1, source: 'manual' } })
    await home.runLater()
    expect(notion.rows.map(r => [r['Note ID'], r['上一層'], r['專案'], r['電腦']])).toEqual([
      [root, '', 'github.com/me/proj', 'HOME'],
      [child, root, 'github.com/me/proj', 'HOME'],
    ])
    // a second push of the same notes writes nothing
    expect(await syncPushAll(home.ports, o)).toEqual({ pushed: 0, failed: 0 })

    const laptop = fake({ notion, machine: 'MAC' })
    expect(await syncPull(laptop.ports, o)).toMatch(/^下載 2 張/)
    const t = await laptop.tree()
    expect(t.nodes[child]?.parentId).toBe(root)
    expect(t.nodes[root]?.answer).toBe('answer #1')
    expect(t.nodes[root]?.title).toBe('標題')
    expect(laptop.toasts.some(x => x.includes('同步了 2 張'))).toBe(true)
    // pulled again: nothing new, and the pulled notes are not pushed back
    expect(await syncPull(laptop.ports, o)).toMatch(/^下載 0 張/)
    expect(await syncPushAll(laptop.ports, o)).toEqual({ pushed: 0, failed: 0 })
    expect(notion.rows).toHaveLength(2)
    // another project's rows stay out
    const other = fake({ notion, machine: 'MAC', remote: 'git@github.com:me/other.git' })
    expect(await syncPull(other.ports, o)).toMatch(/^下載 0 張/)
  })

  test('without a data source nothing is sent', async () => {
    const notion = newNotion()
    const home = fake({ notion })
    await startNote(home.ports, opts, { question: 'q', attach: { kind: 'root' }, answerer: 'fork', route: { label: 'new', confidence: 1, source: 'manual' } })
    await home.runLater()
    expect(notion.rows).toHaveLength(0)
  })
})
