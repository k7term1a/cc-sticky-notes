// Orchestration between the hooks and the pure modules: where a prompt goes,
// creating a note, answering it in the background, keeping the pane's state in sync.
// Everything outside goes through Ports (see ports.ts for why not `$`).
import type { ModelEffort, PluginOptions } from 'claude-code'

import type { Tree } from '../types'
import { answerSide } from './answer'
import { titleAndSummary } from './digest'
import * as jev from './jev'
import type { Ports } from './ports'
import { asEffort, claudeProvider } from './providers/claude'
import { asContextMode, openaiProvider } from './providers/openai'
import type { SummaryProvider } from './providers/types'
import { ASK_OPTIONS, decide, decideFromAsk, type Decision } from './route'
import { addNode, loadTree, mutateTree, sideHistory, treeKey, updateNode, type Attach } from './tree'

export type Options = {
  routeThreshold: number
  followupThreshold: number
  summaryProvider: 'claude' | 'openai'
  claudeModel: string
  claudeEffort: ModelEffort
  openaiModel: string
  openaiContextMode: 'off' | 'redacted' | 'full'
  autoOpenPane: boolean
}

export function readOptions(o: PluginOptions): Options {
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  const str = (v: unknown, d: string) => (typeof v === 'string' && v !== '' ? v : d)
  return {
    routeThreshold: num(o.routeThreshold, 0.6),
    followupThreshold: num(o.followupThreshold, 0.6),
    summaryProvider: o.summaryProvider === 'openai' ? 'openai' : 'claude',
    claudeModel: str(o.claudeModel, 'haiku'),
    claudeEffort: asEffort(o.claudeEffort),
    openaiModel: str(o.openaiModel, 'gpt-5-mini'),
    openaiContextMode: asContextMode(o.openaiContextMode),
    autoOpenPane: o.autoOpenPane === true,
  }
}

export function summaryProvider(p: Ports, opts: Options): SummaryProvider {
  const log = (text: string) => p.ui.log(text, 'debug')
  if (opts.summaryProvider === 'openai') {
    return openaiProvider({ key: p.keys.openai, fetch: p.fetch, log }, { model: opts.openaiModel, contextMode: opts.openaiContextMode })
  }
  return claudeProvider({ complete: p.complete, log }, { model: opts.claudeModel, effort: opts.claudeEffort })
}

/** PLAN.md: one tree per project root ($.session.root()). See PROBE.md about worktrees. */
export async function projectKey(p: Ports): Promise<string> {
  return treeKey(await p.projectRoot())
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

export function dropReason(question: string): string {
  return `→ 便利貼：${snippet(question, 40)}`
}

/** Jev input from the session's own transcript (PLAN.md: raw 300-char clips until M4). */
export async function jevInput(p: Ports, tree: Tree, sessionId: string, prompt: string): Promise<jev.JevInput> {
  const list = await p.messages()
  const active = tree.activeThread[sessionId] ?? null
  const node = active ? tree.nodes[active] : undefined
  const turns = await p.turns()
  const at = await p.state.turnsAtLastSidebar()
  return {
    recentUser: list.filter(m => m.role === 'user' && m.text !== '').map(m => m.text).slice(-3),
    lastAssistant: list.filter(m => m.role === 'assistant' && m.text !== '').at(-1)?.text ?? null,
    activeTitle: node?.title ?? null,
    activeLastQuestion: node?.question ?? null,
    mainTurnsSinceLastSidebar: Math.max(0, turns - at),
    prompt,
    tags: tree.tags,
  }
}

/** Jev, then the decision table; no Jev or low confidence asks the user. */
export async function routePrompt(p: Ports, opts: Options, prompt: string): Promise<Decision> {
  const sessionId = await p.sessionId()
  const tree = await refresh(p)
  const hasActiveThread = (tree.activeThread[sessionId] ?? null) !== null
  const r = await jev.classify({ key: await p.keys.typesafe(), fetch: p.fetch, now: p.now }, await jevInput(p, tree, sessionId, prompt))
  if (!r.ok) p.ui.log(`sticky-notes: Jev unavailable (${r.reason}${r.status ? ` ${r.status}` : ''}); asking`, 'debug')
  const d = decide(r.ok ? r.verdict : null, { route: opts.routeThreshold, followup: opts.followupThreshold }, {
    hasActiveThread,
    tagsKnown: tree.tags.length,
  })
  if (d.kind !== 'ask') return d
  try {
    return decideFromAsk(await p.ui.ask('這句要進主線還是旁支？', ASK_OPTIONS, 'Sticky Notes'), { hasActiveThread })
  } catch {
    // dismissed, or headless (-p): never swallow the user's input
    return { kind: 'main' }
  }
}

export type NoteRequest = {
  question: string
  attach: Attach
  answerer: 'fork' | 'summary-provider'
  route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual' }
  tag?: string
}

/**
 * Writes the node now (answer pending) and answers it in the background.
 * The caller drops the prompt with dropReason() as the visible line.
 */
export async function startNote(p: Ports, opts: Options, req: NoteRequest): Promise<string> {
  const sessionId = await p.sessionId()
  const at = await p.now()
  const turnId = await p.state.lastTurnId()
  const lastUser = (await p.messages()).filter(m => m.role === 'user').at(-1)?.text ?? ''
  const id = crypto.randomUUID()

  await change(p, t =>
    addNode(
      t,
      sessionId,
      {
        id,
        question: req.question,
        anchor: { sessionId, turnId, at, mainSnippet: [...lastUser].slice(0, 120).join('') },
        route: req.route,
        answeredBy: req.answerer === 'fork' ? 'claude-fork' : opts.summaryProvider,
        tags: req.tag ? [req.tag] : [],
      },
      req.attach,
    ).tree,
  )
  await p.state.setTurnsAtLastSidebar(await p.turns())
  await p.state.addPending(1)

  // Answered outside the prompt.submit dispatch: PLAN.md's fallback for
  // "fork inside a hook that drops" (PROBE.md).
  p.later(() => void answerNote(p, opts, id, req))
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
    p.ui.toast(`📌 ${ts.title}`)
    if (opts.autoOpenPane) await p.ui.openPane()
  } finally {
    await p.state.addPending(-1)
  }
}
