// What this mod spent today, for the status line: Jev calls, and the tokens of the
// Claude and OpenAI requests it made. Counted where the requests leave (register.tsx
// wraps the ports' fetch / fork / complete), one $.store key per day shared by every
// session and project, since the quotas are the account's. Two sessions counting at the
// same instant may lose one count (read-modify-write); a gauge, not a bill.
import type { HttpResponse } from 'claude-code'

import { JEV_URL } from './jev'
import type { KV } from './ports'

export type Usage = {
  /** Jev classifications sent (answered or not). */
  jev: number
  /** Claude tokens in, out and cache-written; the fork's cache reads are kept apart. */
  claude: number
  /** Claude cache reads (the fork reads the main line's cached prefix): cheap, not shown. */
  claudeCacheRead: number
  /** OpenAI total_tokens. */
  openai: number
}

export const EMPTY_USAGE: Usage = { jev: 0, claude: 0, claudeCacheRead: 0, openai: 0 }

const pad2 = (n: number) => String(n).padStart(2, '0')

/** `usage:2026-10-14`, the local date. */
export function usageKey(at: Date): string {
  return `usage:${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`
}

export async function readUsage(kv: KV, at: Date): Promise<Usage> {
  return { ...EMPTY_USAGE, ...((await kv.get(usageKey(at))) as Partial<Usage> | undefined) }
}

export async function addUsage(kv: KV, at: Date, delta: Partial<Usage>): Promise<Usage> {
  const u = await readUsage(kv, at)
  const next: Usage = {
    jev: u.jev + (delta.jev ?? 0),
    claude: u.claude + (delta.claude ?? 0),
    claudeCacheRead: u.claudeCacheRead + (delta.claudeCacheRead ?? 0),
    openai: u.openai + (delta.openai ?? 0),
  }
  await kv.set(usageKey(at), next)
  return next
}

/** 1234 → 1.2k, 34567 → 35k. */
export function shortCount(n: number): string {
  if (n < 1000) return String(n)
  return n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

/**
 * The status line (Desktop puts the plugin's name before it, so the text does not):
 * "今日 Jev 12 次 · Claude 34k · OpenAI 8k", OpenAI only once it was used,
 * and "· 2 則回答中" while answers are pending.
 */
export function usageLine(u: Usage, pending: number, paused = false): string {
  const parts = [...(paused ? ['已暫停'] : []), `今日 Jev ${u.jev} 次`, `Claude ${shortCount(u.claude)}`]
  if (u.openai > 0) parts.push(`OpenAI ${shortCount(u.openai)}`)
  if (pending > 0) parts.push(`${pending} 則回答中`)
  return parts.join(' · ')
}

type ModelUsage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

/** What one Claude request (fork or complete) adds. */
export function claudeDelta(usage: ModelUsage | undefined): Partial<Usage> {
  if (!usage) return {}
  return { claude: usage.input_tokens + usage.output_tokens + usage.cache_creation_input_tokens, claudeCacheRead: usage.cache_read_input_tokens }
}

/** What one fetch adds: a Jev call by its URL, OpenAI's total_tokens from its body. */
export function fetchDelta(url: string, r: HttpResponse | null): Partial<Usage> {
  if (url.startsWith(JEV_URL)) return { jev: 1 }
  if (url.includes('api.openai.com') && r?.ok) {
    try {
      const tokens = (JSON.parse(r.text) as { usage?: { total_tokens?: number } }).usage?.total_tokens
      return typeof tokens === 'number' ? { openai: tokens } : {}
    } catch {
      return {}
    }
  }
  return {}
}
