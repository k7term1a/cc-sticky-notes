// Routing feedback: every routing decision is kept as a sample, the user can say
// it was right or wrong, and calibrate() shows what each threshold would do.
// The interface for tuning Jev later (PROBE.md D15); the UI is minimal for now:
// /sticky-note feedback, the $.ui.ask answer, and (M2) the pane's 重新分類.
//
// $.store `route:<root>:<id>`, one key per sample (no shared key to race on),
// at most SAMPLE_CAP per project. Prompts stay in the local store only.
import type { RouteChoice, RouteFeedback, RouteSample } from '../types'
import type { JevVerdict } from './jev'
import type { KV } from './ports'
import type { Decision } from './route'
import { normalizeRoot } from './tree'

export const SAMPLE_CAP = 500
export const PROMPT_KEEP = 200

const prefix = (root: string) => `route:${normalizeRoot(root)}:`

/** Time-ordered id: base-36 epoch ms, zero-padded, so key order is time order. */
export function sampleId(at: number, rand: string): string {
  return `${at.toString(36).padStart(9, '0')}-${rand.slice(0, 8)}`
}

export function choiceOf(d: Decision): RouteSample['decision'] {
  switch (d.kind) {
    case 'sidebar':
      return d.attach === 'followup' ? 'followup' : 'sidebar'
    default:
      return d.kind
  }
}

export function sampleFrom(a: {
  id: string
  at: number
  sessionId: string
  prompt: string
  verdict: JevVerdict | null
  thresholds: RouteSample['thresholds']
  decision: Decision
  nodeId: string | null
  feedback?: RouteFeedback | null
}): RouteSample {
  return {
    id: a.id,
    at: a.at,
    sessionId: a.sessionId,
    prompt: [...a.prompt].slice(0, PROMPT_KEEP).join(''),
    jev: a.verdict && {
      route: a.verdict.route.label,
      confidence: a.verdict.route.confidence,
      isFollowup: a.verdict.isFollowup,
      needsProjectCtx: a.verdict.needsProjectCtx,
      tag: a.verdict.tag?.label ?? null,
    },
    thresholds: a.thresholds,
    decision: choiceOf(a.decision),
    nodeId: a.nodeId,
    feedback: a.feedback ?? null,
  }
}

/** Stores a sample and drops the oldest beyond the cap. */
export async function recordSample(store: KV, root: string, sample: RouteSample): Promise<void> {
  await store.set(prefix(root) + sample.id, sample)
  const mine = (await store.keys()).filter(k => k.startsWith(prefix(root))).sort()
  for (const k of mine.slice(0, Math.max(0, mine.length - SAMPLE_CAP))) await store.delete(k)
}

export async function setFeedback(store: KV, root: string, id: string, feedback: RouteFeedback): Promise<RouteSample | null> {
  const raw = (await store.get(prefix(root) + id)) as RouteSample | undefined
  if (!raw) return null
  const next = { ...raw, feedback }
  await store.set(prefix(root) + id, next)
  return next
}

export async function listSamples(store: KV, root: string): Promise<RouteSample[]> {
  const out: RouteSample[] = []
  for (const k of (await store.keys()).filter(k => k.startsWith(prefix(root))).sort()) {
    const s = (await store.get(k)) as RouteSample | undefined
    if (s) out.push(s)
  }
  return out
}

const CHOICES: Record<string, RouteChoice> = {
  main: 'main',
  主線: 'main',
  sidebar: 'sidebar',
  旁支: 'sidebar',
  note: 'sidebar',
  followup: 'followup',
  追問: 'followup',
  project: 'project_question',
  project_question: 'project_question',
  專案: 'project_question',
}

/** `good` / `bad [main|sidebar|followup|project]` (or 對 / 錯 and the Chinese labels). */
export function parseFeedback(args: string): { verdict: 'right' | 'wrong'; expected: RouteChoice | null } | null {
  const [v, e] = args.trim().split(/\s+/)
  const verdict = v === 'good' || v === '對' ? 'right' : v === 'bad' || v === '錯' ? 'wrong' : null
  if (verdict === null) return null
  const expected = e ? (CHOICES[e.toLowerCase()] ?? null) : null
  if (e && expected === null) return null
  return { verdict, expected }
}

/** main / sidebar / project: sidebar and followup are the same route, they differ in attachment. */
const family = (c: string): 'main' | 'sidebar' | 'project_question' =>
  c === 'main' || c === 'main_task' ? 'main' : c === 'project_question' ? 'project_question' : 'sidebar'

/** The truth a sample carries, if the user said anything. */
export function truthOf(s: RouteSample): RouteChoice | null {
  if (!s.feedback) return null
  if (s.feedback.expected) return s.feedback.expected
  if (s.feedback.verdict === 'right' && s.decision !== 'ask') return s.decision
  return null
}

export type CalibrationRow = {
  threshold: number
  /** Labeled samples Jev would have routed by itself at this threshold. */
  auto: number
  /** …of which Jev's route matched what the user said. */
  correct: number
  /** correct / auto (null when nothing would be auto-routed). */
  accuracy: number | null
  /** Share of labeled samples that would have asked. */
  askRate: number | null
}

/** For each candidate route threshold: how many labeled samples route by themselves, and how many of those are right. */
export function calibrate(samples: readonly RouteSample[], candidates: readonly number[] = [0.5, 0.6, 0.7, 0.8, 0.9]): { labeled: number; rows: CalibrationRow[] } {
  const labeled = samples.filter(s => s.jev !== null && truthOf(s) !== null)
  const rows = candidates.map(threshold => {
    const auto = labeled.filter(s => s.jev!.confidence >= threshold)
    const correct = auto.filter(s => family(s.jev!.route) === family(truthOf(s)!)).length
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
    `路由校正：${c.labeled} 筆有標記`,
    ...c.rows.map(r => `門檻 ${r.threshold.toFixed(2)} · 自動 ${r.auto} 筆，對 ${r.correct}（${pct(r.accuracy)}）· 會詢問 ${pct(r.askRate)}`),
  ]
}
