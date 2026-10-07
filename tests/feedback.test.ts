import { describe, expect, test } from 'claude-code/testing'

import type { RouteSample } from '../types'
import { maskNewArgs, NEW_ARGS_MASK } from '../hooks/commands'
import { calibrate, formatCalibration, listSamples, parseFeedback, recordSample, SAMPLE_CAP, sampleId, truthOf } from '../hooks/feedback'
import type { KV } from '../hooks/ports'
import { describeKey, findKey, keyFiles, parseDotenv, resolveKey } from '../hooks/secrets'

const memKV = (): KV & { size: () => number } => {
  const mem = new Map<string, string>()
  return {
    size: () => mem.size,
    get: async k => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined),
    set: async (k, v) => void mem.set(k, JSON.stringify(v)),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
}

const sample = (i: number, route: string, confidence: number, feedback: RouteSample['feedback']): RouteSample => ({
  id: sampleId(1000 + i, `r${i}`),
  at: 1000 + i,
  sessionId: 'S',
  prompt: `p${i}`,
  jev: { route, confidence, isFollowup: 0, needsProjectCtx: 0, tag: null },
  thresholds: { route: 0.6, followup: 0.6, needsCtx: 0.3 },
  decision: route === 'main_task' ? 'main' : 'sidebar',
  nodeId: null,
  feedback,
})

describe('feedback', () => {
  test('parses good / bad with an optional label, in English or Chinese', () => {
    expect(parseFeedback('good')).toEqual({ verdict: 'right', expected: null })
    expect(parseFeedback('bad project')).toEqual({ verdict: 'wrong', expected: 'project_question' })
    expect(parseFeedback('錯 主線')).toEqual({ verdict: 'wrong', expected: 'main' })
    expect(parseFeedback('bad nonsense')).toBeNull()
    expect(parseFeedback('')).toBeNull()
  })

  test('ids sort by time, and the store keeps at most SAMPLE_CAP per project', async () => {
    expect(sampleId(5, 'a') < sampleId(40, 'a')).toBe(true)
    const kv = memKV()
    for (let i = 0; i < SAMPLE_CAP + 3; i++) await recordSample(kv, '/p', sample(i, 'main_task', 1, null))
    await recordSample(kv, '/other', sample(0, 'main_task', 1, null))
    const kept = await listSamples(kv, '/p')
    expect(kept).toHaveLength(SAMPLE_CAP)
    expect(kept[0]?.prompt).toBe('p3')
    expect(await listSamples(kv, '/other')).toHaveLength(1)
  })

  test('truth: the expected label, else the decision when it was right', () => {
    expect(truthOf(sample(0, 'main_task', 1, { verdict: 'right', expected: null, at: 0, source: 'command' }))).toBe('main')
    expect(truthOf(sample(0, 'main_task', 1, { verdict: 'wrong', expected: 'sidebar', at: 0, source: 'command' }))).toBe('sidebar')
    expect(truthOf(sample(0, 'main_task', 1, { verdict: 'wrong', expected: null, at: 0, source: 'command' }))).toBeNull()
    expect(truthOf(sample(0, 'main_task', 1, null))).toBeNull()
  })

  test('calibrate: accuracy and ask rate per threshold', () => {
    const fb = (expected: RouteSample['decision']) => ({ verdict: 'right' as const, expected: expected === 'ask' ? null : expected, at: 0, source: 'command' as const })
    const samples = [
      sample(1, 'sidebar_knowledge', 0.95, fb('sidebar')),
      sample(2, 'sidebar_knowledge', 0.65, fb('project_question')), // the D15 case
      sample(3, 'main_task', 0.99, fb('main')),
      sample(4, 'main_task', 0.55, fb('main')),
      sample(5, 'main_task', 0.9, null), // unlabeled: ignored
    ]
    const c = calibrate(samples, [0.5, 0.6, 0.7])
    expect(c.labeled).toBe(4)
    expect(c.rows).toEqual([
      { threshold: 0.5, auto: 4, correct: 3, accuracy: 0.75, askRate: 0 },
      { threshold: 0.6, auto: 3, correct: 2, accuracy: 2 / 3, askRate: 0.25 },
      { threshold: 0.7, auto: 2, correct: 2, accuracy: 1, askRate: 0.5 },
    ])
    expect(formatCalibration(c)[0]).toBe('路由校正：4 筆有標記')
  })
})

describe('P10: /sticky-note new leaves no question in the transcript', () => {
  const record = '<command-name>/sticky-note</command-name>\n            <command-message>sticky-note</command-message>\n            <command-args>new TCP 的 backpressure 是什麼原理？</command-args>'

  test('masks the args of new, leaves everything else', () => {
    expect(maskNewArgs(record)).toBe(record.replace('new TCP 的 backpressure 是什麼原理？', NEW_ARGS_MASK))
    expect(maskNewArgs(record.replace('new TCP', 'back TCP'))).toBeNull()
    expect(maskNewArgs(record.replace('/sticky-note</command-name>', '/other</command-name>'))).toBeNull()
  })
})

describe('keys from files (no machine-wide env vars needed)', () => {
  test('parseDotenv: BOM, CRLF, quotes, export, comments', () => {
    expect(parseDotenv('\uFEFFTYPESAFE_API_KEY="apikey_x"\r\nexport OPENAI_API_KEY=sk-y # mine\r\n# c\r\n')).toEqual({ TYPESAFE_API_KEY: 'apikey_x', OPENAI_API_KEY: 'sk-y' })
  })

  test('order: environment, then ~/.claude/sticky-notes/.env, then the plugin folder', async () => {
    const files = keyFiles('C:\\Users\\me', 'C:\\dev\\cc-sticky-notes')
    expect(files).toEqual(['C:\\Users\\me\\.claude\\sticky-notes\\.env', 'C:\\dev\\cc-sticky-notes\\.env'])
    const disk: Record<string, string> = { [files[1]!]: 'OPENAI_API_KEY=from-plugin\nTYPESAFE_API_KEY=ts-plugin', [files[0]!]: 'OPENAI_API_KEY=from-home' }
    const read = async (p: string) => {
      if (!(p in disk)) throw new Error('ENOENT')
      return disk[p]!
    }
    expect(await resolveKey('OPENAI_API_KEY', 'from-env', files, read)).toBe('from-env')
    expect(await resolveKey('OPENAI_API_KEY', undefined, files, read)).toBe('from-home')
    expect(await resolveKey('TYPESAFE_API_KEY', '', files, read)).toBe('ts-plugin')
    expect(describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', undefined, files, read))).toBe(`OPENAI_API_KEY：有（${files[0]}）`)
    delete disk[files[1]!]
    expect(await resolveKey('TYPESAFE_API_KEY', undefined, files, read)).toBeUndefined()
    expect(describeKey('TYPESAFE_API_KEY', null)).toContain('找不到')
  })
})
