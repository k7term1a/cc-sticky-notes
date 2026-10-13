// TypeSafe Jev client. The only file that knows Jev's request/response schema.
// Schema source: third-party write-up (apidog.com/blog/what-is-jev), NOT yet checked
// against console.typesafe.ai — see PROBE.md. Endpoint reachability is verified
// (403 "Must supply an API key!" without a key).
import type { HttpInit, HttpResponse } from 'claude-code'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const JEV_MODEL = 'jev-latest'

export type RouteLabel = 'main_task' | 'sidebar_knowledge' | 'project_question'
export const NEW_TAG = '__new__'
/** The `continues` answer for "none of the listed notes". */
export const NO_NOTE = 'none'

/** What the rest of the mod sees: schema-free. */
export type JevVerdict = {
  route: { label: RouteLabel; confidence: number }
  /** Probability that the prompt continues the active thread. */
  isFollowup: number
  /** Probability that answering needs the project's code or conversation. */
  needsProjectCtx: number
  /** Absent when there were no tags to choose from. */
  tag?: { label: string; confidence: number }
  /**
   * Which listed note the prompt continues: a candidate's key (`n1`…) or NO_NOTE,
   * with each key's probability when Jev gives them. Absent when none were listed.
   */
  continues?: { label: string; confidence: number; probabilities: Record<string, number> }
}

/** A recent note Jev may say the prompt continues; `key` is how the request names it. */
export type Candidate = { key: string; title: string; question: string }

export type JevInput = {
  /** R4: the summary layer's digest of this session's main line; null before the first one. */
  digest: string | null
  /** R4: the newest project facts (context.ts), short. */
  facts: string[]
  /** Last user prompts (oldest first) and the last assistant reply, raw. */
  recentUser: string[]
  lastAssistant: string | null
  activeTitle: string | null
  activeLastQuestion: string | null
  mainTurnsSinceLastSidebar: number
  prompt: string
  tags: string[]
  /** Recent notes, newest first (notes.ts chooses them); none, no `continues` question. */
  candidates: Candidate[]
}

const CLIP = 300
/** PLAN.md: Jev reads worse with a state of more than a few thousand characters; a pasted wall of text is cut here (the note keeps it whole). */
export const PROMPT_CLIP = 1500

const clip = (s: string, n = CLIP) => ([...s].length > n ? [...s].slice(0, n).join('') + '…' : s)

/** The last `n` characters, … before them: a reply's conclusion is at its end. */
const tail = (s: string, n = CLIP) => ([...s].length > n ? '…' + [...s].slice(-n).join('') : s)

/** The `state` text, as PLAN.md「Jev 分類設計」lays it out (R4: the digest and the project facts first). */
export function buildState(input: JevInput): string {
  const recent = [...input.recentUser.slice(-3).map(u => `user: ${clip(u)}`)]
  if (input.lastAssistant !== null) recent.push(`assistant: ${tail(input.lastAssistant)}`)
  return [
    ...(input.digest !== null ? ['[main-line digest]', input.digest, ''] : []),
    ...(input.facts.length > 0 ? ['[project facts]', ...input.facts.map(f => `- ${clip(f, 100)}`), ''] : []),
    '[recent main-line context]',
    recent.length ? recent.join('\n') : '(none)',
    '',
    '[sidebar state]',
    `active_thread_title: ${input.activeTitle ?? 'none'}`,
    `active_thread_last_question: ${input.activeLastQuestion === null ? 'none' : clip(input.activeLastQuestion)}`,
    `main_turns_since_last_sidebar: ${input.mainTurnsSinceLastSidebar}`,
    '',
    '[new prompt]',
    clip(input.prompt, PROMPT_CLIP),
  ].join('\n')
}

export function buildRequest(input: JevInput): unknown {
  const questions: Record<string, unknown> = {
    route: {
      type: 'choice',
      instructions: 'Where should the new prompt go?',
      criteria: {
        main_task: 'Advances the project: an instruction, a code change, or a decision about what Claude just did',
        sidebar_knowledge: 'Asks about a principle, concept or background knowledge; does not ask Claude to change anything',
        project_question:
          'A question about this project itself whose answer belongs in the main conversation: it refers to "we", "our", "here", ' +
          '"this project" or to code and decisions in this conversation, e.g. "why do we use session cookies here instead of JWT?", ' +
          '"為什麼我們這裡用 X？", "這個專案為什麼要這樣分層？"',
      },
    },
    is_followup: {
      type: 'noul',
      instructions: 'Does the new prompt continue the topic of active_thread?',
    },
    needs_project_ctx: {
      type: 'noul',
      instructions: "Does answering the new prompt require seeing the project's code or conversation?",
    },
  }
  if (input.candidates.length > 0) {
    const criteria: Record<string, string> = {}
    for (const c of input.candidates) criteria[c.key] = `Continues the sticky note "${c.title}" (last asked: ${clip(c.question, 120)})`
    criteria[NO_NOTE] = 'Continues none of these notes: a new topic, or not about a sticky note'
    questions.continues = { type: 'choice', instructions: 'Which existing sticky note does the new prompt follow up?', criteria }
  }
  if (input.tags.length > 0) {
    const criteria: Record<string, string> = {}
    for (const t of input.tags) criteria[t] = `About ${t}`
    criteria[NEW_TAG] = 'None of the existing tags fits'
    questions.tag = { type: 'choice', instructions: 'Which topic tag fits the new prompt?', criteria }
  }
  return { model: JEV_MODEL, state: buildState(input), questions }
}

type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities?: Record<string, unknown> }
type NoulAnswer = { type: 'noul'; noul: number }

const isRoute = (s: unknown): s is RouteLabel =>
  s === 'main_task' || s === 'sidebar_knowledge' || s === 'project_question'

/** Response → JevVerdict; null when the shape is not what we expect. */
export function parseResponse(body: unknown): JevVerdict | null {
  const answers = (body as { answers?: Record<string, unknown> } | null)?.answers
  if (!answers) return null
  const route = answers.route as ChoiceAnswer | undefined
  const fu = answers.is_followup as NoulAnswer | undefined
  const ctx = answers.needs_project_ctx as NoulAnswer | undefined
  if (!route || !isRoute(route.choice) || typeof route.confidence !== 'number') return null
  if (typeof fu?.noul !== 'number' || typeof ctx?.noul !== 'number') return null
  const verdict: JevVerdict = {
    route: { label: route.choice, confidence: route.confidence },
    isFollowup: fu.noul,
    needsProjectCtx: ctx.noul,
  }
  const tag = answers.tag as ChoiceAnswer | undefined
  if (tag && typeof tag.choice === 'string' && typeof tag.confidence === 'number') {
    verdict.tag = { label: tag.choice, confidence: tag.confidence }
  }
  const cont = answers.continues as ChoiceAnswer | undefined
  if (cont && typeof cont.choice === 'string' && typeof cont.confidence === 'number') {
    const probabilities: Record<string, number> = {}
    for (const [k, v] of Object.entries(cont.probabilities ?? {})) if (typeof v === 'number') probabilities[k] = v
    verdict.continues = { label: cont.choice, confidence: cont.confidence, probabilities }
  }
  return verdict
}

export type JevResult =
  | { ok: true; verdict: JevVerdict; ms: number }
  | { ok: false; reason: 'no-key' | 'http' | 'bad-response' | 'network'; status?: number; ms: number }

export type JevDeps = {
  key: string | undefined
  fetch(url: string, init?: HttpInit): Promise<HttpResponse>
  now(): Promise<number>
}

/** One classification call. Never throws; the caller degrades to $.ui.ask on !ok. */
export async function classify(d: JevDeps, input: JevInput): Promise<JevResult> {
  const t0 = await d.now()
  const ms = async () => (await d.now()) - t0
  const key = d.key
  if (!key) return { ok: false, reason: 'no-key', ms: 0 }
  try {
    const r = await d.fetch(JEV_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(buildRequest(input)),
    })
    if (!r.ok) return { ok: false, reason: 'http', status: r.status, ms: await ms() }
    let body: unknown
    try {
      body = JSON.parse(r.text)
    } catch {
      return { ok: false, reason: 'bad-response', status: r.status, ms: await ms() }
    }
    const verdict = parseResponse(body)
    return verdict ? { ok: true, verdict, ms: await ms() } : { ok: false, reason: 'bad-response', status: r.status, ms: await ms() }
  } catch {
    return { ok: false, reason: 'network', ms: await ms() }
  }
}
