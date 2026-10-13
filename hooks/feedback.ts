// Routing feedback: every prompt Jev saw is kept with Jev's call, its confidence
// and the user's choice (the dialog's pick, or /sn feedback afterwards), so the
// threshold can be tuned later (PROBE.md D15). calibrate() shows what each
// threshold would do.
//
// $.store `feedback:<root>:<id>`, one key per record (no shared key to race on),
// at most RECORD_CAP per project. Prompts stay in the local store only.
import type { AskChoice, FeedbackRecord } from '../types'
import type { JevVerdict } from './jev'
import type { KV } from './ports'
import { normalizeRoot } from './tree'

export const RECORD_CAP = 500
export const PROMPT_KEEP = 200

const prefix = (root: string) => `feedback:${normalizeRoot(root)}:`

/** Time-ordered id: base-36 epoch ms, zero-padded, so key order is time order. */
export function recordId(at: number, rand: string): string {
  return `${at.toString(36).padStart(9, '0')}-${rand.slice(0, 8)}`
}

export function makeRecord(a: {
  id: string
  at: number
  sessionId: string
  prompt: string
  verdict: JevVerdict
  thresholds: FeedbackRecord['thresholds']
  asked: boolean
  outcome: FeedbackRecord['outcome']
  choice: AskChoice | null
  nodeId: string | null
}): FeedbackRecord {
  return {
    id: a.id,
    at: a.at,
    sessionId: a.sessionId,
    prompt: [...a.prompt].slice(0, PROMPT_KEEP).join(''),
    jev: {
      route: a.verdict.route.label,
      confidence: a.verdict.route.confidence,
      isFollowup: a.verdict.isFollowup,
      needsProjectCtx: a.verdict.needsProjectCtx,
      tag: a.verdict.tag?.label ?? null,
    },
    thresholds: a.thresholds,
    asked: a.asked,
    outcome: a.outcome,
    choice: a.choice,
    choiceSource: a.choice === null ? null : 'ask',
    nodeId: a.nodeId,
  }
}

/** Stores a record and drops the oldest beyond the cap. */
export async function saveRecord(store: KV, root: string, record: FeedbackRecord): Promise<void> {
  await store.set(prefix(root) + record.id, record)
  const mine = (await store.keys()).filter(k => k.startsWith(prefix(root))).sort()
  for (const k of mine.slice(0, Math.max(0, mine.length - RECORD_CAP))) await store.delete(k)
}

export async function getRecord(store: KV, root: string, id: string): Promise<FeedbackRecord | null> {
  return ((await store.get(prefix(root) + id)) as FeedbackRecord | undefined) ?? null
}

/** /sn feedback: the user's choice for a record, said afterwards. */
export async function setChoice(store: KV, root: string, id: string, choice: AskChoice): Promise<FeedbackRecord | null> {
  const raw = (await store.get(prefix(root) + id)) as FeedbackRecord | undefined
  if (!raw) return null
  const next: FeedbackRecord = { ...raw, choice, choiceSource: 'command' }
  await store.set(prefix(root) + id, next)
  return next
}

export async function listRecords(store: KV, root: string): Promise<FeedbackRecord[]> {
  const out: FeedbackRecord[] = []
  for (const k of (await store.keys()).filter(k => k.startsWith(prefix(root))).sort()) {
    const r = (await store.get(k)) as FeedbackRecord | undefined
    if (r) out.push(r)
  }
  return out
}

const CHOICES: Record<string, AskChoice> = {
  main: 'main',
  主線: 'main',
  project: 'main',
  new: 'new',
  sidebar: 'new',
  note: 'new',
  旁支: 'new',
  便利貼: 'new',
  followup: 'followup',
  追問: 'followup',
}

/**
 * `/sn feedback <main|new|followup>`: what the last prompt should have been.
 * `good` keeps what happened. Chinese labels work too (主線 / 便利貼 / 追問).
 */
export function parseFeedback(args: string): { choice: AskChoice } | { good: true } | null {
  const word = args.trim().split(/\s+/)[0] ?? ''
  if (word === 'good' || word === '對') return { good: true }
  const choice = CHOICES[word.toLowerCase()]
  return choice ? { choice } : null
}

/** Jev's route and the user's choice compared as main line vs. sticky note. */
const isMain = (x: string) => x === 'main' || x === 'main_task' || x === 'project_question'

export type CalibrationRow = {
  threshold: number
  /** Records Jev would let through to the main line without asking at this threshold. */
  auto: number
  /** …of which the user also wanted the main line. */
  correct: number
  /** correct / auto (null when nothing would go through unasked). */
  accuracy: number | null
  /** Share of the records that would show the dialog. */
  askRate: number | null
}

/**
 * Only main_task / project_question go through unasked (sidebar_knowledge always
 * asks), so the threshold trades the dialogs shown against prompts wrongly sent
 * to the main line. Records without a choice are left out.
 */
export function calibrate(records: readonly FeedbackRecord[], candidates: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9]): { labeled: number; rows: CalibrationRow[] } {
  const labeled = records.filter(r => r.choice !== null)
  const rows = candidates.map(threshold => {
    const auto = labeled.filter(r => isMain(r.jev.route) && r.jev.confidence >= threshold)
    const correct = auto.filter(r => isMain(r.choice!)).length
    return {
      threshold,
      auto: auto.length,
      correct,
      accuracy: auto.length ? correct / auto.length : null,
      askRate: labeled.length ? 1 - auto.length / labeled.length : null,
    }
  })
  return { labeled: labeled.length, rows }
}

export function formatCalibration(c: ReturnType<typeof calibrate>): string[] {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`)
  return [
    `路由校正：${c.labeled} 筆有你的選擇`,
    ...c.rows.map(r => `門檻 ${r.threshold.toFixed(2)} · 不問直接進主線 ${r.auto} 筆，其中你也要主線 ${r.correct}（${pct(r.accuracy)}）· 會跳對話框 ${pct(r.askRate)}`),
  ]
}
