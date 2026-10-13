// Orchestration between the hooks and the pure modules: where a prompt goes,
// creating a note, answering it in the background, keeping the pane's state in
// sync, and keeping the routing feedback records. Everything outside goes through Ports.
import type { ModelEffort, PluginOptions } from 'claude-code'

import type { AskChoice, FeedbackRecord, Tree, TreeNode } from '../types'
import { answerSide } from './answer'
import { digestDue, FACTS_FOR_JEV, lastExchanges, readDigest, readFacts, runDigest } from './context'
import { titleAndSummary } from './digest'
import { getRecord, makeRecord, recordId, saveRecord, setChoice } from './feedback'
import * as jev from './jev'
import type { Ports } from './ports'
import { asEffort, claudeProvider } from './providers/claude'
import { asContextMode, asReasoningEffort, openaiProvider, type OpenAIReasoningEffort } from './providers/openai'
import { withFallback, type SummaryProvider } from './providers/types'
import { askPrompt, choiceOf, decide, decideFromChoice, NEEDS_CTX_AT, pickPrompt, type Decision, type Suggested } from './route'
import { addNode, loadTree, migrateLegacy, mutateTree, normalizeRoot, sideHistory, updateNode, type Attach } from './tree'

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
  /** R4: the main-line digest and the project context every this many main turns; 0 turns them off. */
  digestEvery: number
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
    autoOpenPane: o.autoOpenPane !== false, // default on (the developer's pick, 10/07)
    digestEvery: Math.max(0, Math.floor(num(o.digestEvery, 3))), // every 3 turns (the developer's pick, 10/14)
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

/** session.start: move a tree saved in the old one-key layout, then load. */
export async function prepare(p: Ports): Promise<Tree> {
  const moved = await migrateLegacy(p.store, await projectKey(p))
  if (moved > 0) p.ui.log(`sticky-notes: moved ${moved} notes to the per-node store layout`, 'debug')
  return refresh(p)
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

/** How much of the question the drop card quotes, and of the answer the log line previews (the developer: keep them short). */
export const QUESTION_CHARS = 24
export const PREVIEW_CHARS = 40

/** Markdown flattened to one plain line (headings, emphasis, code, tables, list marks dropped), first n characters. */
export function plainPreview(md: string, n: number): string {
  const text = md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, ' ') // table rules
    .replace(/^\s{0,3}(#{1,6}|[-*+]|\d+\.)\s+/gm, '')
    .replace(/[*_`|>#]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  return snippet(text, n)
}

/** The drop reason is the transparency line (PLAN.md / PROBE.md P2). */
export function dropReason(question: string): string {
  return `cc-sticky-note：便利貼「${snippet(question, QUESTION_CHARS)}」`
}

/**
 * The reason under the desktop's own "A hook blocked your prompt" card (the card
 * is the app's; the reason is ours): where the note went. Every note comes from
 * the user's pick now, so there is no "Jev decided" wording.
 */
export function explainDrop(question: string, routed: Routed): string {
  const where =
    routed.decision.kind === 'sidebar' && routed.decision.attach === 'followup' && routed.parentTitle !== null
      ? `接在「${routed.parentTitle}」下`
      : '新的便利貼'
  return `cc-sticky-note：${where}「${snippet(question, QUESTION_CHARS)}」`
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

/** How many recent notes Jev is asked about (`continues`): enough to find the one, few enough to stay accurate. */
export const CANDIDATES = 8

/** The notes Jev may say a prompt continues: this session's activeThread first, then the newest. */
export function recentNotes(tree: Tree, activeId: string | null, n = CANDIDATES): TreeNode[] {
  const active = activeId ? tree.nodes[activeId] : undefined
  const rest = Object.values(tree.nodes)
    .filter(x => x.id !== active?.id)
    .sort((a, b) => b.anchor.at - a.anchor.at)
  return (active ? [active, ...rest] : rest).slice(0, n)
}

/**
 * A note by a keyword typed under the dialog's "Other": the newest whose title
 * or question holds it (brackets and case ignored), or whose title it holds.
 */
export function findNote(tree: Tree, typed: string): TreeNode | null {
  const k = typed.replace(/[「」『』"']/g, '').trim().toLowerCase()
  if (k === '') return null
  const hits = Object.values(tree.nodes).filter(n => {
    const title = n.title.toLowerCase()
    return title.includes(k) || n.question.toLowerCase().includes(k) || ([...title].length >= 2 && k.includes(title))
  })
  return hits.sort((a, b) => b.anchor.at - a.anchor.at)[0] ?? null
}

/** Jev input from the session's own transcript (PLAN.md: raw 300-char clips until M4). */
export async function jevInput(p: Ports, tree: Tree, sessionId: string, prompt: string, candidates: jev.Candidate[] = []): Promise<jev.JevInput> {
  const list = await p.messages()
  const active = tree.activeThread[sessionId] ?? null
  const node = active ? tree.nodes[active] : undefined
  const turns = await p.turns()
  const at = await p.state.turnsAtLastSidebar()
  const root = await projectKey(p)
  return {
    digest: (await readDigest(p.store, root, sessionId))?.text ?? null,
    facts: (await readFacts(p.store, root)).slice(-FACTS_FOR_JEV).map(f => f.text),
    recentUser: list.filter(isTypedPrompt).map(m => m.text).slice(-3),
    lastAssistant: list.filter(m => m.role === 'assistant' && m.text !== '').at(-1)?.text ?? null,
    activeTitle: node?.title ?? null,
    activeLastQuestion: node?.question ?? null,
    mainTurnsSinceLastSidebar: Math.max(0, turns - at),
    prompt,
    tags: tree.tags,
    candidates,
  }
}

export type Routed = {
  decision: Decision
  verdict: jev.JevVerdict | null
  /** Whether the dialog was shown. */
  asked: boolean
  /** The user's pick in the dialogs; null when not asked, dismissed, or free text that found no note. */
  choice: AskChoice | null
  /** Title of the note a follow-up goes under; null otherwise. */
  parentTitle: string | null
}

/**
 * The note the dialog offers first: the one Jev says the prompt continues, else
 * this session's activeThread (how likely: is_followup); none without either.
 */
function suggestionOf(verdict: jev.JevVerdict, keyed: readonly { key: string; node: TreeNode }[], active: TreeNode | undefined): Suggested | null {
  const c = verdict.continues
  const hit = c && c.label !== jev.NO_NOTE ? keyed.find(k => k.key === c.label) : undefined
  if (hit && c) return { id: hit.node.id, title: hit.node.title, likely: c.confidence }
  return active ? { id: active.id, title: active.title, likely: verdict.isFollowup } : null
}

/** The notes for the second dialog: all but the suggested one, likeliest first by Jev, then newest. */
function othersOf(verdict: jev.JevVerdict, keyed: readonly { key: string; node: TreeNode }[], suggested: Suggested | null): TreeNode[] {
  const prob = verdict.continues?.probabilities ?? {}
  return keyed
    .filter(k => k.node.id !== suggested?.id)
    .map((k, i) => ({ node: k.node, score: prob[k.key] ?? 0, i }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(x => x.node)
}

/**
 * Jev, then the decision table (route.ts). Jev never makes a note by itself:
 * a confident main_task goes through, anything that might be a note asks.
 * No Jev (no key, an error) → main line, no dialog. A Remote Control (bridge)
 * prompt never gets the dialog: where it would ask, it goes to the main line.
 *
 * The dialog offers the note Jev says the prompt continues (else the activeThread);
 * 〔接在其他便利貼下…〕 opens a second dialog of the other recent notes. In either,
 * text typed under "Other" is a keyword for the note (findNote); none found, the
 * prompt goes to the main line and a toast says so.
 */
export async function routePrompt(p: Ports, opts: Options, prompt: string, via: { remote?: boolean } = {}): Promise<Routed> {
  const sessionId = await p.sessionId()
  const tree = await refresh(p)
  const activeId = tree.activeThread[sessionId] ?? null
  const active = activeId === null ? undefined : tree.nodes[activeId]
  const keyed = recentNotes(tree, activeId).map((node, i) => ({ key: `n${i + 1}`, node }))
  const candidates = keyed.map(k => ({ key: k.key, title: k.node.title, question: k.node.question }))
  const none = { asked: false, choice: null, parentTitle: null }
  const r = await jev.classify({ key: await p.keys.typesafe(), fetch: p.fetch, now: p.now }, await jevInput(p, tree, sessionId, prompt, candidates))
  if (!r.ok) {
    if (r.reason !== 'no-key') p.ui.log(`sticky-notes: Jev unavailable (${r.reason}${r.status ? ` ${r.status}` : ''}); main line`, 'debug')
    return { decision: { kind: 'main' }, verdict: null, ...none }
  }
  const verdict = r.verdict
  const decision = decide(verdict, { route: opts.routeThreshold, followup: opts.followupThreshold })
  if (decision.kind !== 'ask') return { decision, verdict, ...none }
  if (via.remote) return { decision: { kind: 'main' }, verdict, ...none }

  const suggested = suggestionOf(verdict, keyed, active)
  const others = othersOf(verdict, keyed, suggested)
  const dialog = askPrompt(verdict, { suggested, hasOthers: others.length > 0, followupThreshold: opts.followupThreshold })
  const ask = (question: string, labels: string[]) => p.ui.ask(question, labels, 'Sticky Notes')
  type Got = { choice: AskChoice | null; parent: TreeNode | null }
  /** Free text under "Other": the note it names, or the main line with a toast. */
  const byKeyword = (typed: string): Got => {
    const hit = findNote(tree, typed)
    if (hit === null) p.ui.toast(`Sticky Notes：找不到「${[...typed].slice(0, 20).join('')}」的便利貼，這句送進主線`)
    return { choice: hit ? 'followup' : null, parent: hit }
  }
  try {
    const answer = await ask(dialog.question, dialog.options.map(o => o.label))
    const picked = choiceOf(dialog, answer)
    let got: Got
    if (picked === 'pick') {
      const second = pickPrompt(others)
      const a2 = await ask(second.question, second.options.map(o => o.label))
      const opt = second.options.find(o => o.label === a2)
      got = opt === undefined ? byKeyword(a2) : opt.id === null ? { choice: 'main', parent: null } : { choice: 'followup', parent: tree.nodes[opt.id] ?? null }
    } else if (picked === null) got = byKeyword(answer)
    else got = { choice: picked, parent: picked === 'followup' && suggested ? (tree.nodes[suggested.id] ?? null) : null }
    return {
      decision: decideFromChoice(got.choice, verdict, tree.tags.length, got.parent?.id),
      verdict,
      asked: true,
      choice: got.choice,
      parentTitle: got.parent?.title ?? null,
    }
  } catch {
    // dismissed, or headless (-p): never swallow the user's input
    return { decision: { kind: 'main' }, verdict, ...none, asked: true }
  }
}

/**
 * R4: one digest run for this session (context.ts), through the summary provider.
 * `force` runs it whatever digestEvery says (/sn ctx refresh).
 */
export async function digestNow(p: Ports, opts: Options, force = false): Promise<string> {
  const root = await projectKey(p)
  const sessionId = await p.sessionId()
  const turns = await p.turns()
  if (!force && !digestDue(opts.digestEvery, turns, await readDigest(p.store, root, sessionId))) return 'not due'
  const r = await runDigest(
    { kv: p.store, provider: summaryProvider(p, opts), root, sessionId, turns, now: await p.now(), newId: () => crypto.randomUUID() },
    lastExchanges(await p.messages(), isTypedPrompt),
  )
  if (!r.ok) {
    p.ui.log(`sticky-notes: main digest skipped (${r.reason})`, 'debug')
    return r.reason
  }
  await p.state.contextChanged()
  return r.added > 0 ? `digest written, ${r.added} new fact(s)` : 'digest written'
}

/** What a routed prompt became, in the record's words. */
export function outcomeOf(d: Decision): FeedbackRecord['outcome'] {
  if (d.kind === 'project_question') return 'project_question'
  if (d.kind === 'sidebar') return d.attach === 'followup' ? 'followup' : 'new'
  return 'main'
}

/**
 * Keeps one feedback record (Jev's call, its confidence, the user's choice) at
 * feedback:<root>:<id>. Prompts Jev never saw (no key) are not kept.
 */
export async function recordFeedback(p: Ports, opts: Options, prompt: string, routed: Routed, nodeId: string | null): Promise<string | null> {
  if (routed.verdict === null) return null
  const at = await p.now()
  const id = recordId(at, crypto.randomUUID())
  await saveRecord(
    p.store,
    await projectKey(p),
    makeRecord({
      id,
      at,
      sessionId: await p.sessionId(),
      prompt,
      verdict: routed.verdict,
      thresholds: { route: opts.routeThreshold, followup: opts.followupThreshold, needsCtx: NEEDS_CTX_AT },
      asked: routed.asked,
      outcome: outcomeOf(routed.decision),
      choice: routed.choice,
      nodeId,
    }),
  )
  await p.state.setLastSampleId(id)
  return id
}

/**
 * /sn feedback: the user's choice for this session's last record, said afterwards.
 * `good` keeps what happened (a project question counts as the main line).
 */
export async function giveFeedback(p: Ports, fb: { choice: AskChoice } | { good: true }): Promise<FeedbackRecord | null> {
  const id = await p.state.lastSampleId()
  if (id === null) return null
  const root = await projectKey(p)
  if ('choice' in fb) return setChoice(p.store, root, id, fb.choice)
  const record = await getRecord(p.store, root, id)
  if (record === null) return null
  return setChoice(p.store, root, id, record.outcome === 'project_question' ? 'main' : record.outcome)
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
  // the pane follows the newest note of this session (its answer shows as it arrives)
  await p.state.setSelected(id)

  // Answered outside the prompt.submit dispatch (PROBE.md: works, and the
  // drop line shows at once instead of after the 1–3 s fork). Nothing may
  // escape a background job: a failure marks the note and says so.
  p.later(() => {
    answerNote(p, opts, id, req).catch(async (err: unknown) => {
      p.ui.log(`sticky-notes: answering failed: ${String(err).slice(0, 200)}`, 'debug')
      p.ui.toast('Sticky Notes：回答失敗')
      await change(p, t => updateNode(t, id, { answer: '_(回答失敗)_' })).catch(() => {})
    })
  })
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
    // $.ui.log is plain text (no Markdown): one clean line here, the rendered answer in the pane.
    p.ui.log(`cc-sticky-note ${ts.title}：${plainPreview(ts.summary ?? a.text, PREVIEW_CHARS)}　/sn 看完整答案`)
    p.ui.toast(`cc-sticky-note ${ts.title}`)
    if (opts.autoOpenPane) await p.ui.openPane()
  } finally {
    await p.state.addPending(-1)
  }
}
