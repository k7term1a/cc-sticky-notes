// Orchestration between the hooks and the pure modules: where a prompt goes,
// creating a note, answering it in the background, keeping the pane's state in
// sync, and keeping routing samples. Everything outside goes through Ports.
import type { ModelEffort, PluginOptions } from 'claude-code'

import type { RouteFeedback, Tree } from '../types'
import { answerSide } from './answer'
import { titleAndSummary } from './digest'
import { choiceOf, recordSample, sampleFrom, sampleId, setFeedback } from './feedback'
import * as jev from './jev'
import type { Ports } from './ports'
import { asEffort, claudeProvider } from './providers/claude'
import { asContextMode, asReasoningEffort, openaiProvider, type OpenAIReasoningEffort } from './providers/openai'
import { withFallback, type SummaryProvider } from './providers/types'
import { ASK_OPTIONS, decide, decideFromAsk, NEEDS_CTX_AT, type Decision } from './route'
import { addNode, loadTree, mutateTree, normalizeRoot, sideHistory, updateNode, type Attach } from './tree'

export type Options = {
  routeThreshold: number
  followupThreshold: number
  summaryProvider: 'claude' | 'openai'
  claudeModel: string
  claudeEffort: ModelEffort
  openaiModel: string
  openaiReasoningEffort: OpenAIReasoningEffort
  openaiContextMode: 'off' | 'redacted' | 'full'
  autoOpenPane: boolean
}

export function readOptions(o: PluginOptions): Options {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : d)
  return {
    routeThreshold: num(o.routeThreshold, 0.6),
    followupThreshold: num(o.followupThreshold, 0.6),
    summaryProvider: o.summaryProvider === 'openai' ? 'openai' : 'claude',
    claudeModel: str(o.claudeModel, 'haiku'),
    claudeEffort: asEffort(o.claudeEffort),
    openaiModel: str(o.openaiModel, 'gpt-5-mini'),
    openaiReasoningEffort: asReasoningEffort(o.openaiReasoningEffort),
    openaiContextMode: asContextMode(o.openaiContextMode),
    autoOpenPane: o.autoOpenPane === true,
  }
}

/** The configured summary provider; openai without a key falls back to claude with one toast. */
export function summaryProvider(p: Ports, opts: Options): SummaryProvider {
  const log = (text: string) => p.ui.log(text, 'debug')
  const claude = claudeProvider({ complete: p.complete, log }, { model: opts.claudeModel, effort: opts.claudeEffort })
  if (opts.summaryProvider !== 'openai') return claude
  const openai = openaiProvider(
    { key: p.keys.openai, fetch: p.fetch, log },
    { model: opts.openaiModel, contextMode: opts.openaiContextMode, reasoningEffort: opts.openaiReasoningEffort },
  )
  return withFallback(openai, claude, () => p.ui.toast('Sticky Notes：沒有 OPENAI_API_KEY，統整層改用 Claude'))
}

/** PLAN.md: the repo root (shared by every worktree), else the session root. */
export async function projectKey(p: Ports): Promise<string> {
  return normalizeRoot(await p.projectRoot())
}

export async function refresh(p: Ports): Promise<Tree> {
  const tree = await loadTree(p.store, await projectKey(p))
  await p.state.publishTree(tree)
  return tree
}

export async function change(p: Ports, fn: (t: Tree) => Tree): Promise<Tree> {
  const tree = await mutateTree(p.store, await projectKey(p), fn)
  await p.state.publishTree(tree)
  return tree
}

export function snippet(s: string, n: number): string {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}

/** First n characters, newlines kept (answers are Markdown). */
const clip = (s: string, n: number) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s)

/** The drop reason is the transparency line (PLAN.md / PROBE.md P2). */
export function dropReason(question: string): string {
  return `→ 便利貼：${snippet(question, 40)}`
}

/**
 * A user message the person typed: not a slash-command record or caveat
 * (`<command-name>…`, `<local-command-…>`), which $.session.messages() also lists.
 */
export function isTypedPrompt(m: { role: string; text: string }): boolean {
  if (m.role !== 'user') return false
  const t = m.text.trimStart()
  return t !== '' && !/^<(command-|local-command-|system-reminder)/.test(t)
}

/** Jev input from the session's own transcript (PLAN.md: raw 300-char clips until M4). */
export async function jevInput(p: Ports, tree: Tree, sessionId: string, prompt: string): Promise<jev.JevInput> {
  const list = await p.messages()
  const active = tree.activeThread[sessionId] ?? null
  const node = active ? tree.nodes[active] : undefined
  const turns = await p.turns()
  const at = await p.state.turnsAtLastSidebar()
  return {
    recentUser: list.filter(isTypedPrompt).map(m => m.text).slice(-3),
    lastAssistant: list.filter(m => m.role === 'assistant' && m.text !== '').at(-1)?.text ?? null,
    activeTitle: node?.title ?? null,
    activeLastQuestion: node?.question ?? null,
    mainTurnsSinceLastSidebar: Math.max(0, turns - at),
    prompt,
    tags: tree.tags,
  }
}

export type Routed = {
  decision: Decision
  verdict: jev.JevVerdict | null
  /** The label the user picked when asked; null when not asked (or dismissed). */
  asked: string | null
}

/**
 * Jev, then the decision table. No Jev (no key, an error) → main line, no
 * dialog (PLAN.md「沒有 Jev key 時」). Low confidence → $.ui.ask.
 */
export async function routePrompt(p: Ports, opts: Options, prompt: string): Promise<Routed> {
  const sessionId = await p.sessionId()
  const tree = await refresh(p)
  const hasActiveThread = (tree.activeThread[sessionId] ?? null) !== null
  const r = await jev.classify({ key: await p.keys.typesafe(), fetch: p.fetch, now: p.now }, await jevInput(p, tree, sessionId, prompt))
  if (!r.ok) {
    if (r.reason !== 'no-key') p.ui.log(`sticky-notes: Jev unavailable (${r.reason}${r.status ? ` ${r.status}` : ''}); main line`, 'debug')
    return { decision: { kind: 'main' }, verdict: null, asked: null }
  }
  const decision = decide(r.verdict, { route: opts.routeThreshold, followup: opts.followupThreshold }, {
    hasActiveThread,
    tagsKnown: tree.tags.length,
  })
  if (decision.kind !== 'ask') return { decision, verdict: r.verdict, asked: null }
  try {
    const asked = await p.ui.ask('這句要進主線還是旁支？', ASK_OPTIONS, 'Sticky Notes')
    return { decision: decideFromAsk(asked, { hasActiveThread }), verdict: r.verdict, asked }
  } catch {
    // dismissed, or headless (-p): never swallow the user's input
    return { decision: { kind: 'main' }, verdict: r.verdict, asked: null }
  }
}

/**
 * Keeps one routing sample for calibration. Prompts Jev never saw (no key)
 * are not kept. When the user was asked, their answer is the label.
 */
export async function recordRoute(p: Ports, opts: Options, prompt: string, routed: Routed, nodeId: string | null): Promise<string | null> {
  if (routed.verdict === null) return null
  const at = await p.now()
  const id = sampleId(at, crypto.randomUUID())
  const feedback: RouteFeedback | null =
    routed.asked === null ? null : { verdict: 'right', expected: choiceOf(routed.decision) as RouteFeedback['expected'], at, source: 'ask' }
  await recordSample(
    p.store,
    await projectKey(p),
    sampleFrom({
      id,
      at,
      sessionId: await p.sessionId(),
      prompt,
      verdict: routed.verdict,
      thresholds: { route: opts.routeThreshold, followup: opts.followupThreshold, needsCtx: NEEDS_CTX_AT },
      decision: routed.asked === null ? routed.decision : { kind: 'ask', why: 'low-confidence' },
      nodeId,
      feedback,
    }),
  )
  await p.state.setLastSampleId(id)
  return id
}

/** /sticky-note feedback: marks this session's last routing sample. */
export async function giveFeedback(p: Ports, feedback: Omit<RouteFeedback, 'at'>): Promise<boolean> {
  const id = await p.state.lastSampleId()
  if (id === null) return false
  return (await setFeedback(p.store, await projectKey(p), id, { ...feedback, at: await p.now() })) !== null
}

export type NoteRequest = {
  question: string
  attach: Attach
  answerer: 'fork' | 'summary-provider'
  route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual' }
  tag?: string
}

async function anchorFor(p: Ports) {
  const sessionId = await p.sessionId()
  const lastUser = (await p.messages()).filter(isTypedPrompt).at(-1)?.text ?? ''
  return {
    sessionId,
    turnId: await p.state.lastTurnId(),
    messageId: await p.state.lastPromptUuid(),
    at: await p.now(),
    mainSnippet: [...lastUser].slice(0, 120).join(''),
  }
}

/**
 * Writes the node now (answer pending) and answers it in the background.
 * The caller drops the prompt with dropReason() as the visible line.
 */
export async function startNote(p: Ports, opts: Options, req: NoteRequest): Promise<string> {
  const anchor = await anchorFor(p)
  const id = crypto.randomUUID()
  await change(p, t =>
    addNode(
      t,
      anchor.sessionId,
      {
        id,
        question: req.question,
        anchor,
        route: req.route,
        answeredBy: req.answerer === 'fork' ? 'claude-fork' : opts.summaryProvider,
        tags: req.tag ? [req.tag] : [],
      },
      req.attach,
    ).tree,
  )
  await p.state.setTurnsAtLastSidebar(await p.turns())
  await p.state.addPending(1)

  // Answered outside the prompt.submit dispatch (PROBE.md: works, and the
  // drop line shows at once instead of after the 1–3 s fork).
  p.later(() => void answerNote(p, opts, id, req))
  return id
}

/**
 * project_question: the prompt goes to the main line with context; the tree
 * keeps a bookmark that is already "promoted" and never becomes activeThread.
 */
export async function bookmarkNote(p: Ports, question: string, route: NoteRequest['route']): Promise<string> {
  const anchor = await anchorFor(p)
  const id = crypto.randomUUID()
  await change(p, t =>
    addNode(
      t,
      anchor.sessionId,
      { id, question, anchor, route, answeredBy: 'claude', promotedAt: anchor.at, promotedIn: anchor.sessionId },
      { kind: 'root' },
      { makeActive: false },
    ).tree,
  )
  return id
}

export async function answerNote(p: Ports, opts: Options, id: string, req: NoteRequest): Promise<void> {
  const provider = summaryProvider(p, opts)
  try {
    const tree = await refresh(p)
    const history = sideHistory(tree, tree.nodes[id]?.parentId ?? null)
    const a = await answerSide(p.fork, { question: req.question, history, answerer: req.answerer }, provider)
    if (!a.ok) {
      await change(p, t => updateNode(t, id, { answer: `_(沒有答案：${a.reason})_` }))
      p.ui.toast(`Sticky Notes：回答失敗（${a.reason}）`)
      return
    }
    await change(p, t => updateNode(t, id, { answer: a.text, answeredBy: a.answeredBy }))
    const ts = await titleAndSummary(provider, req.question, a.text)
    await change(p, t => updateNode(t, id, { title: ts.title, summary: ts.summary }))
    await p.state.addUnread(1)
    // M1 (PLAN.md): the answer is shown with $.ui.log — a dim transcript line the model never reads.
    p.ui.log(`📌 ${ts.title}${a.answeredBy === 'claude-fork' ? '' : '（無專案脈絡）'}\n${clip(a.text, 2000)}`)
    p.ui.toast(`📌 ${ts.title}`)
    if (opts.autoOpenPane) await p.ui.openPane()
  } finally {
    await p.state.addPending(-1)
  }
}
