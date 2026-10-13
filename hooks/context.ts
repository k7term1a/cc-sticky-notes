// R4: the main-line digest (what this session is doing, for Jev) and the project
// context (durable facts of the project, only ever added to by the summary layer,
// pruned by hand). One summary-layer call every `digestEvery` main turns, in the
// background after the turn ends (register.tsx turn.complete).
//
//   $.store digest:<root>:<sessionId>  → SessionDigest   (one per session: sessions do different things)
//   $.store context:<root>             → ContextFact[]   (one per project, every session adds to it)
import type { SummaryProvider } from './providers/types'
import type { KV } from './ports'
import { LANGUAGE_RULE } from './digest'

export type SessionDigest = {
  text: string
  /** $.session.turns() when it was written: the next one is due digestEvery turns later. */
  turns: number
  at: number
}

export type ContextFact = {
  id: string
  text: string
  at: number
  sessionId: string
  source: 'auto' | 'manual'
}

export const DIGEST_MAX = 200
export const FACT_MAX = 100
export const FACTS_PER_RUN = 3
/** What the project context keeps at most: beyond it the oldest automatic facts go first. */
export const FACTS_KEPT = 60
/** What Jev reads of the project context: the newest few, each short. */
export const FACTS_FOR_JEV = 8

export const digestKey = (root: string, sessionId: string) => `digest:${root}:${sessionId}`
export const contextKey = (root: string) => `context:${root}`

export async function readDigest(kv: KV, root: string, sessionId: string): Promise<SessionDigest | null> {
  const d = (await kv.get(digestKey(root, sessionId))) as SessionDigest | undefined
  return d && typeof d.text === 'string' ? d : null
}

export async function readFacts(kv: KV, root: string): Promise<ContextFact[]> {
  const list = (await kv.get(contextKey(root))) as ContextFact[] | undefined
  return Array.isArray(list) ? list : []
}

/** Whether a digest is due: digestEvery turns since the last one (0 turns it off). */
export function digestDue(every: number, turns: number, last: SessionDigest | null): boolean {
  if (every <= 0) return false
  return turns - (last?.turns ?? 0) >= every
}

const clip = (s: string, n: number) => {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}
/** A reply's head and tail: the conclusion is usually at the end. */
const headTail = (s: string, n: number) => {
  const cps = [...s.trim()]
  return cps.length > 2 * n ? `${cps.slice(0, n).join('')}\n…\n${cps.slice(-n).join('')}` : cps.join('')
}

export type Exchange = { user: string; assistant: string }

const DIGEST_SYSTEM =
  'You keep two notes about a coding session for a router that decides where the next prompt goes. ' +
  `(1) "digest": at most ${DIGEST_MAX} characters on what the main line is doing now, what was just decided, and what is still open; ` +
  'rewrite it from the previous digest and the latest exchanges. ' +
  `(2) "facts": 0–${FACTS_PER_RUN} durable facts about the project worth remembering beyond this session ` +
  `(a decision, a convention, a constraint, a pitfall), each at most ${FACT_MAX} characters, none that the known facts already say; ` +
  'an empty list when there is nothing new. ' +
  `${LANGUAGE_RULE} Reply with JSON only: {"digest": "...", "facts": ["..."]}`

export function digestPrompt(previous: string | null, exchanges: readonly Exchange[], known: readonly string[]): string {
  return [
    `[previous digest]\n${previous ?? '(none)'}`,
    `[known project facts]\n${known.length ? known.map(f => `- ${f}`).join('\n') : '(none)'}`,
    `[latest exchanges, oldest first]\n${exchanges.map(x => `user: ${clip(x.user, 600)}\nassistant: ${headTail(x.assistant, 600)}`).join('\n\n')}`,
  ].join('\n\n')
}

/** Accepts a bare JSON object or one in a ```json fence; null when the shape is off. */
export function parseDigest(text: string): { digest: string; facts: string[] } | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  try {
    const o = JSON.parse(m[0]) as { digest?: unknown; facts?: unknown }
    if (typeof o.digest !== 'string' || o.digest.trim() === '') return null
    const facts = Array.isArray(o.facts) ? o.facts.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : []
    return { digest: clip(o.digest, DIGEST_MAX), facts: facts.slice(0, FACTS_PER_RUN).map(f => clip(f, FACT_MAX)) }
  } catch {
    return null
  }
}

/** New facts not already there (the same text, spaces and case aside); over FACTS_KEPT the oldest automatic ones go. */
export function addFacts(list: readonly ContextFact[], add: readonly ContextFact[]): ContextFact[] {
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const seen = new Set(list.map(f => norm(f.text)))
  const fresh = add.filter(f => !seen.has(norm(f.text)) && (seen.add(norm(f.text)), true))
  const all = [...list, ...fresh]
  if (all.length <= FACTS_KEPT) return all
  // over the cap: the oldest automatic facts go; the ones added by hand stay
  let drop = all.length - FACTS_KEPT
  return all.filter(f => (drop > 0 && f.source === 'auto' ? (drop--, false) : true))
}

/**
 * One digest run: the summary layer reads the previous digest, the known facts and
 * the latest exchanges, and writes the new digest and any new facts. Never throws;
 * a failed or malformed answer leaves both as they were and says why.
 */
export async function runDigest(
  d: { kv: KV; provider: SummaryProvider; root: string; sessionId: string; turns: number; now: number; newId: () => string },
  exchanges: readonly Exchange[],
): Promise<{ ok: true; digest: string; added: number } | { ok: false; reason: string }> {
  if (exchanges.length === 0) return { ok: false, reason: 'no exchanges' }
  const previous = await readDigest(d.kv, d.root, d.sessionId)
  const facts = await readFacts(d.kv, d.root)
  const r = await d.provider.summarize('main-digest', {
    system: DIGEST_SYSTEM,
    prompt: digestPrompt(previous?.text ?? null, exchanges, facts.map(f => f.text)),
    maxTokens: 600,
    hasProjectContent: true,
  })
  if (!r.ok) return { ok: false, reason: `${r.provider} ${r.reason}${r.detail ? ` ${r.detail}` : ''}` }
  const parsed = parseDigest(r.text)
  if (!parsed) return { ok: false, reason: 'malformed answer' }
  await d.kv.set(digestKey(d.root, d.sessionId), { text: parsed.digest, turns: d.turns, at: d.now } satisfies SessionDigest)
  const fresh = parsed.facts.map(text => ({ id: d.newId(), text, at: d.now, sessionId: d.sessionId, source: 'auto' as const }))
  const next = addFacts(facts, fresh)
  if (next.length !== facts.length || fresh.length > 0) await d.kv.set(contextKey(d.root), next)
  return { ok: true, digest: parsed.digest, added: next.length - facts.length }
}

/** The main-line exchanges the digest reads: the last `n` typed prompts, each with the reply after it. */
export function lastExchanges(messages: readonly { role: string; text: string }[], isTyped: (m: { role: string; text: string }) => boolean, n = 3): Exchange[] {
  const out: Exchange[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (!isTyped(m)) continue
    let reply = ''
    for (let j = i + 1; j < messages.length && !isTyped(messages[j]!); j++) if (messages[j]!.role === 'assistant' && messages[j]!.text !== '') reply = messages[j]!.text
    out.push({ user: m.text, assistant: reply })
  }
  return out.slice(-n)
}
