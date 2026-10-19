// Orchestration between the hooks and the pure modules: where a prompt goes,
// creating a note, answering it in the background, keeping the pane's state in
// sync, and keeping the routing feedback records. Everything outside goes through Ports.
import type { ModelEffort, PluginOptions } from 'claude-code'

import type { AskChoice, FeedbackRecord, Tree, TreeNode } from '../types'
import { answerSide } from './answer'
import { digestDue, FACTS_FOR_JEV, lastExchanges, readDigest, readFacts, runDigest } from './context'
import { titleAndSummary } from './digest'
import { getRecord, listRecords, makeRecord, recordId, saveRecord, setChoice } from './feedback'
import * as jev from './jev'
import { markUnsynced, pullNotes, pushNote, type SyncPorts } from './notion'
import type { Ports } from './ports'
import { asEffort, claudeProvider } from './providers/claude'
import { asContextMode, asReasoningEffort, openaiProvider, type OpenAIReasoningEffort } from './providers/openai'
import { withFallback, type SummaryProvider } from './providers/types'
import { askPrompt, choiceOf, decide, decideFromChoice, MAIN_LABEL, NEEDS_CTX_AT, pickPrompt, type Decision, type Suggested } from './route'
import { addNode, removeNode, loadTree, migrateLegacy, mutateTree, normalizeRoot, sideHistory, updateNode, type Attach } from './tree'

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
  /** Jev reads each prompt and may ask (the mod's main switch, /sn on|off); off (the default), everything goes to the main line. */
  routing: boolean
  /** Notes sync with Notion when a data source is set; off keeps the data source but sends nothing. */
  notionSync: boolean
  /** R4: the main-line digest and the project context every this many main turns; 0 turns them off. */
  digestEvery: number
  /** The Notion data source the notes sync to (collection://…); '' turns the sync off. */
  notionDataSource: string
  /** Seconds the dialog waits before the prompt goes to the main line by itself; 0 waits forever. */
  askTimeout: number
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
    routing: o.routing === true, // paused unless turned on (the developer, 10/19): /sn on, the settings card
    notionSync: true,
    notionDataSource: typeof o.notionDataSource === 'string' ? o.notionDataSource.trim() : '',
    askTimeout: Math.max(0, Math.floor(num(o.askTimeout, 30))), // 30 s (the developer, 10/14)
    digestEvery: Math.max(0, Math.floor(num(o.digestEvery, 3))), // every 3 turns (the developer's pick, 10/14)
  }
}

/** What /sn provider, /sn every and /sn notion set, kept per machine in $.store over the plugin settings. */
export const OVERRIDABLE = ['summaryProvider', 'digestEvery', 'notionDataSource', 'askTimeout', 'routing', 'notionSync', 'autoOpenPane'] as const
export type OverridableField = (typeof OVERRIDABLE)[number]
export const optionKey = (field: (typeof OVERRIDABLE)[number]) => 'option:' + field

/** Puts this machine's own settings (optionKey) over the plugin's, in place. */
export async function applyOptionOverrides(kv: { get(key: string): Promise<unknown> }, opts: Options): Promise<void> {
  const provider = await kv.get(optionKey('summaryProvider'))
  if (provider === 'claude' || provider === 'openai') opts.summaryProvider = provider
  const every = await kv.get(optionKey('digestEvery'))
  if (typeof every === 'number' && Number.isInteger(every) && every >= 0) opts.digestEvery = every
  const notion = await kv.get(optionKey('notionDataSource'))
  if (typeof notion === 'string') opts.notionDataSource = notion
  const timeout = await kv.get(optionKey('askTimeout'))
  if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 0) opts.askTimeout = timeout
  for (const field of ['routing', 'notionSync', 'autoOpenPane'] as const) {
    const v = await kv.get(optionKey(field))
    if (typeof v === 'boolean') opts[field] = v
  }
}

/** Whether notes go to (and come from) Notion now: a data source, and the switch on. */
export const syncing = (opts: Options) => opts.notionSync && opts.notionDataSource !== ''

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

/**
 * The project_question bookmarks the mod kept until 10/12 (「這題在主線回答」): no answer,
 * promoted at creation. The developer asked them gone (10/14); nothing makes them any more.
 */
export function isMainLineBookmark(n: TreeNode): boolean {
  return n.promotedAt !== null && n.answer === '' && n.route.label === 'project_question' && n.children.length === 0
}

/** session.start: move a tree saved in the old one-key layout, drop the old bookmarks, then load. */
export async function prepare(p: Ports): Promise<Tree> {
  const root = await projectKey(p)
  const moved = await migrateLegacy(p.store, root)
  if (moved > 0) p.ui.log(`sticky-notes: moved ${moved} notes to the per-node store layout`, 'debug')
  const tree = await loadTree(p.store, root)
  const bookmarks = Object.values(tree.nodes).filter(isMainLineBookmark)
  if (bookmarks.length > 0) {
    await mutateTree(p.store, root, t => bookmarks.reduce((acc, n) => removeNode(acc, n.id), t))
    p.ui.log(`sticky-notes: removed ${bookmarks.length} old 在主線回答 bookmarks`, 'debug')
  }
  // notes made before the card showed Jev's call: it is in their feedback record
  const unknown = Object.values(tree.nodes).filter(n => n.route.jev === undefined && n.route.source !== 'manual')
  if (unknown.length > 0) {
    const byNode = new Map<string, string>()
    for (const r of await listRecords(p.store, root)) if (r.nodeId) byNode.set(r.nodeId, r.jev.route)
    const found = unknown.filter(n => byNode.has(n.id))
    if (found.length > 0) {
      await mutateTree(p.store, root, t => {
        const nodes = { ...t.nodes }
        for (const n of found) if (nodes[n.id]) nodes[n.id] = { ...nodes[n.id]!, route: { ...nodes[n.id]!.route, jev: byNode.get(n.id) } }
        return { ...t, nodes }
      })
    }
  }
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

/** What the dialog race answers when askTimeout passed first (no label can be this). */
const TIMED_OUT = '\u0000timed-out'

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
  // a new session's first prompt opens the work: the main line, no Jev, no dialog (the developer, 10/14)
  if (!(await p.messages()).some(isTypedPrompt)) return { decision: { kind: 'main' }, verdict: null, ...none }
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
  /**
   * The dialog, raced by askTimeout: unanswered by then, the prompt goes to the main line
   * (TIMED_OUT). A mod cannot take an asked dialog down, so it stays on screen; a pick
   * made in it afterwards changes nothing and says so.
   */
  const ask = async (question: string, labels: string[]): Promise<string> => {
    const asked = p.ui.ask(question, labels, 'Sticky Notes')
    if (opts.askTimeout <= 0) return asked
    let late = false
    const timer = p.sleep(opts.askTimeout * 1000).then(() => ((late = true), TIMED_OUT))
    asked.then(
      a => void (late && labels.includes(a) && a !== MAIN_LABEL && p.ui.toast('Sticky Notes：這句已經逾時送進主線了，這次的選擇沒有作用')),
      () => {},
    )
    const first = await Promise.race([asked, timer])
    if (first === TIMED_OUT) p.ui.toast(`Sticky Notes：${opts.askTimeout} 秒沒有回應，這句送進主線`)
    return first
  }
  type Got = { choice: AskChoice | null; parent: TreeNode | null }
  /** Free text under "Other": the note it names, or the main line with a toast. */
  const byKeyword = (typed: string): Got => {
    const hit = findNote(tree, typed)
    if (hit === null) p.ui.toast(`Sticky Notes：找不到「${[...typed].slice(0, 20).join('')}」的便利貼，這句送進主線`)
    return { choice: hit ? 'followup' : null, parent: hit }
  }
  try {
    const answer = await ask(dialog.question, dialog.options.map(o => o.label))
    if (answer === TIMED_OUT) return { decision: { kind: 'main' }, verdict, ...none, asked: true }
    const picked = choiceOf(dialog, answer)
    let got: Got
    if (picked === 'pick') {
      const second = pickPrompt(others)
      const a2 = await ask(second.question, second.options.map(o => o.label))
      if (a2 === TIMED_OUT) return { decision: { kind: 'main' }, verdict, ...none, asked: true }
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
  // the context card shows the run: 統整中… now, then how it ended (DIGEST_WORDS)
  await p.state.setDigestStatus(true, null)
  let out = 'error'
  try {
    const r = await runDigest(
      { kv: p.store, provider: summaryProvider(p, opts), root, sessionId, turns, now: await p.now(), newId: () => crypto.randomUUID(), every: opts.digestEvery || 3 },
      lastExchanges(await p.messages(), isTypedPrompt),
    )
    if (!r.ok) {
      p.ui.log(`sticky-notes: main digest skipped (${r.reason})`, 'debug')
      out = r.reason
    } else out = r.added > 0 ? `digest written, ${r.added} new fact(s)` : 'digest written'
  } catch (err) {
    out = `error ${String(err).slice(0, 120)}`
  } finally {
    await p.state.setDigestStatus(false, digestWords(out))
    await p.state.contextChanged()
  }
  return out
}

/** A digest run's outcome in the card's words. */
export function digestWords(out: string): string {
  const added = /^digest written, (\d+) new fact/.exec(out)
  if (added) return `完成，新增 ${added[1]} 條脈絡`
  if (out === 'digest written') return '完成，沒有新的脈絡'
  if (out === 'no exchanges') return '沒有統整：主線還沒有對話'
  if (out === 'malformed answer') return '沒有統整：統整層的回答格式不對'
  return `沒有統整：${out}`
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
  route: { label: string; confidence: number; source: 'jev' | 'ask' | 'manual'; jev?: string }
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
        // the tag is the topic's: on a first question only (answerNote names one when Jev gave none)
        tags: req.tag && req.attach.kind === 'root' ? [req.tag] : [],
      },
      req.attach,
    ).tree,
  )
  await p.state.setTurnsAtLastSidebar(await p.turns())
  // R4: this session's first note starts its main-line digest (the whole session), in the background;
  // after that turn.complete keeps it every digestEvery turns (the developer, 10/14)
  if (opts.digestEvery > 0 && (await readDigest(p.store, await projectKey(p), anchor.sessionId)) === null) {
    p.later(() => void digestNow(p, opts, true))
  }
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
    // the answered note goes to Notion for the other computers, in the background
    if (syncing(opts)) p.later(() => void syncPush(p, opts, id))
  } finally {
    await p.state.addPending(-1)
  }
}

const syncPorts = (p: Ports): SyncPorts => ({ ...p, projectKey: () => projectKey(p) })
const syncStatusKey = async (p: Ports) => `notion-status:${await projectKey(p)}`

/**
 * Deletes a note and the follow-ups under it, here only (the developer, 10/14). Their
 * Notion rows, if any, are marked 不同步 so no other computer pulls them from now on;
 * the notion:<root>:<id> keys stay, so this computer never pulls them back either.
 */
export async function deleteNote(p: Ports, opts: Options, id: string): Promise<number> {
  const before = await refresh(p)
  if (!before.nodes[id]) return 0
  const gone: string[] = []
  const walk = (nid: string) => {
    gone.push(nid)
    for (const c of before.nodes[nid]?.children ?? []) walk(c)
  }
  walk(id)
  const parent = before.nodes[id]!.parentId
  await change(p, t => removeNode(t, id))
  const selected = await p.state.selected()
  if (selected !== null && gone.includes(selected)) await p.state.setSelected(parent)
  if (syncing(opts)) p.later(() => void markUnsynced(syncPorts(p), opts.notionDataSource, gone))
  return gone.length
}

/** ✕ and /sn rm: the dialog first (how much goes), then deleteNote. Dismissed, nothing goes. */
export async function confirmDelete(p: Ports, opts: Options, id: string): Promise<number> {
  const tree = await refresh(p)
  const node = tree.nodes[id]
  if (!node) return 0
  let below = 0
  const count = (nid: string) => (tree.nodes[nid]?.children ?? []).forEach(c => (below++, count(c)))
  count(id)
  const what = `「${node.title}」${below > 0 ? `和它底下 ${below} 則追問` : ''}`
  try {
    const a = await p.ui.ask(`刪除${what}？只刪這台電腦的，Notion 上會標成不同步。`, ['刪除', '取消'], 'Sticky Notes')
    if (a !== '刪除') return 0
  } catch {
    return 0
  }
  const n = await deleteNote(p, opts, id)
  p.ui.toast(`Sticky Notes：已刪除${what}`)
  return n
}

/** One note to Notion; how it went is kept for /sn notion. */
export async function syncPush(p: Ports, opts: Options, id: string): Promise<string> {
  const node = (await refresh(p)).nodes[id]
  if (!node) return 'gone'
  const r = await pushNote(syncPorts(p), opts.notionDataSource, node)
  if (r !== 'pushed' && r !== 'skipped') {
    p.ui.log(`sticky-notes: Notion push failed (${r})`, 'debug')
    await p.store.set(await syncStatusKey(p), `上傳失敗：${r}`)
  }
  return r
}

/** /sn notion push: every answered note of this project not yet in Notion. */
export async function syncPushAll(p: Ports, opts: Options): Promise<{ pushed: number; failed: number }> {
  const tree = await refresh(p)
  let pushed = 0
  let failed = 0
  for (const node of Object.values(tree.nodes).sort((a, b) => a.anchor.at - b.anchor.at)) {
    const r = await pushNote(syncPorts(p), opts.notionDataSource, node)
    if (r === 'pushed') pushed++
    else if (r !== 'skipped') failed++
  }
  await p.store.set(await syncStatusKey(p), `上傳 ${pushed} 張${failed ? `，${failed} 張失敗` : ''}（${new Date(await p.now()).toLocaleString()}）`)
  return { pushed, failed }
}

/** The other computers' notes of this project into the tree; a toast when any came. */
export async function syncPull(p: Ports, opts: Options): Promise<string> {
  const r = await pullNotes(syncPorts(p), opts.notionDataSource, fn => change(p, fn), await refresh(p))
  const text = 'error' in r ? `下載失敗：${r.error}` : `下載 ${r.added} 張`
  await p.store.set(await syncStatusKey(p), `${text}（${new Date(await p.now()).toLocaleString()}）`)
  if ('error' in r) p.ui.log(`sticky-notes: Notion pull failed (${r.error})`, 'debug')
  else if (r.added > 0) p.ui.toast(`Sticky Notes：從其他電腦同步了 ${r.added} 張便利貼`)
  return text
}

/** The last sync's outcome, for /sn notion. */
export async function syncStatus(p: Ports): Promise<string | null> {
  const s = await p.store.get(await syncStatusKey(p))
  return typeof s === 'string' ? s : null
}
