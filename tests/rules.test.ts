// R7: the project's rules on cards, what compaction is told, and what a new session reads.
import { describe, expect, mock, test } from 'claude-code/testing'

import { cardsOf, compactInstructions, OLD_CARD, parseDigest, RULES_BUDGET, rulesBlock, type ContextFact } from '../hooks/context'
import { buildReminderRequest } from '../hooks/jev'

const ROOT = '/proj'
const ONE = [{ role: 'user', text: 'hi', toolUses: [] }] as never
const fact = (id: string, text: string, more: Partial<ContextFact> = {}): ContextFact => ({ id, text, at: Number(id.replace(/\D/g, '')) || 1, sessionId: 'S0', source: 'auto', ...more })

describe('rule cards', () => {
  test('facts group by card, the card added to last first; facts from before R7 share one', () => {
    const cards = cardsOf([fact('1', 'old'), fact('2', 'a', { card: 'git', kind: 'rule' }), fact('3', 'b', { card: '語言', kind: 'habit' }), fact('4', 'c', { card: 'git' })])
    expect(cards.map(c => [c.title, c.kind, c.facts.map(f => f.text)])).toEqual([
      ['git', 'rule', ['a', 'c']],
      ['語言', 'habit', ['b']],
      [OLD_CARD, null, ['old']],
    ])
  })

  test('the summary layer puts each fact on a card with a kind; plain strings still read', () => {
    expect(parseDigest('{"digest":"d","facts":[{"card":"git","kind":"rule","text":"不要自己 push"},"舊的寫法",{"card":"x","kind":"weird","text":"t"},{"card":"y"}]}')).toEqual({
      digest: 'd',
      facts: [{ text: '不要自己 push', card: 'git', kind: 'rule' }, { text: '舊的寫法' }, { text: 't', card: 'x' }],
    })
  })

  test('the rules block: the kept ones first and whole, then the cards while the budget lasts', () => {
    expect(rulesBlock([])).toBeNull()
    const block = rulesBlock([fact('1', '不要自己 push', { card: 'git', kind: 'rule' }), fact('2', '一律用繁體中文', { card: '語言', kind: 'habit', keep: true })])!
    expect(block).toContain('Must follow (the user marked these):\n- [習慣] 一律用繁體中文')
    expect(block).toContain('## git\n- [規範] 不要自己 push')
    expect(block.indexOf('一律用繁體中文')).toBeLessThan(block.indexOf('## git'))
    const many = Array.from({ length: 200 }, (_, i) => fact(String(i + 1), '很長的一條規範'.repeat(10), { card: `c${i % 20}` }))
    expect(rulesBlock(many)!.length).toBeLessThanOrEqual(RULES_BUDGET)
  })

  test('compaction: handed every rule to keep the ones the work needs, and the kept ones word for word', () => {
    expect(compactInstructions([], 'the plan')).toBe('the plan')
    const plain = compactInstructions([fact('1', 'x', { card: 'git', kind: 'rule' })], undefined)!
    expect(plain).toContain('keep the ones that bear on the work still in progress')
    expect(plain).toContain('## git\n- [規範] x')
    expect(plain).not.toContain('word for word')
    const kept = compactInstructions([fact('1', 'x'), fact('2', '一律用繁體中文', { keep: true })], 'the plan')!
    expect(kept.startsWith('the plan\n\n')).toBe(true)
    expect(kept).toContain('word for word under that heading whatever the work:\n- 一律用繁體中文')
    expect(kept.match(/一律用繁體中文/g)).toHaveLength(1) // not listed twice
  })

  test('Jev is asked one question about the prompt, with the rules and the last exchange', () => {
    const r = buildReminderRequest({ lastUser: '改一下', lastAssistant: '好了', rules: ['一律用繁體中文'], prompt: '怎麼又用簡體' }) as { state: string; questions: Record<string, { type: string }> }
    expect(Object.keys(r.questions)).toEqual(['broke_rule'])
    expect(r.questions.broke_rule!.type).toBe('noul')
    expect(r.state).toContain('[project rules]\n- 一律用繁體中文')
    expect(r.state.endsWith('[new prompt]\n怎麼又用簡體')).toBe(true)
  })
})

describe('the hooks', () => {
  const rules = [fact('1', '不要自己 push', { card: 'git', kind: 'rule' }), fact('2', '一律用繁體中文', { card: '語言', kind: 'habit', keep: true })]

  test('a new session carries the rules block', async ($, on) => {
    mock.store(on, { [`context:${ROOT}`]: rules })
    on('session.id', () => ({ value: 'S1' }))
    on('session.root', () => ({ value: ROOT }))
    on('session.repo', () => ({ value: null }))
    on('session.messages', () => ({ value: [{ role: 'user', text: '開始', toolUses: [] }] }) as never)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    const r = await $.prompt.context({ blocks: [{ name: 'currentDate', text: 'today' }] })
    expect(r.blocks.map(b => b.name)).toEqual(['currentDate', 'projectRules'])
    expect(r.blocks[1]!.text).toContain('- [習慣] 一律用繁體中文')
  })

  test('a resumed session (replies in it already) and one just compacted carry none', async ($, on) => {
    mock.store(on, { [`context:${ROOT}`]: rules })
    on('session.id', () => ({ value: 'S1' }))
    on('session.root', () => ({ value: ROOT }))
    on('session.repo', () => ({ value: null }))
    on('session.turns', () => ({ value: 0 }))
    let messages = [{ role: 'user', text: 'q', toolUses: [] }, { role: 'assistant', text: 'a', toolUses: [] }]
    on('session.messages', () => ({ value: messages }) as never)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    on('session.compact', ($, e) => ({ messages: e.messages }))
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
    // compacted: the summary alone is left, no reply, and still no block
    await $.session.compact({ trigger: 'manual', messages: ONE })
    messages = [{ role: 'user', text: 'summary', toolUses: [] }]
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  test('no rules, no block', async ($, on) => {
    mock.store(on)
    on('session.id', () => ({ value: 'S1' }))
    on('session.root', () => ({ value: ROOT }))
    on('session.repo', () => ({ value: null }))
    on('session.messages', () => ({ value: [] }) as never)
    on('prompt.context', ($, e) => ({ blocks: e.blocks }))
    expect((await $.prompt.context({ blocks: [] })).blocks).toEqual([])
  })

  test('compaction: the summarizer gets the rules instructions; a digest runs first when there is something new', async ($, on) => {
    mock.store(on, { [`context:${ROOT}`]: rules, [`digest:${ROOT}:S1`]: { text: 'd', turns: 4, prompts: 1, at: 1 } })
    mock.clock(on)
    on('session.id', () => ({ value: 'S1' }))
    on('session.root', () => ({ value: ROOT }))
    on('session.repo', () => ({ value: null }))
    on('session.turns', () => ({ value: 4 }))
    let told: string | undefined
    on('session.compact', ($, e) => {
      told = e.instructions
      return { messages: e.messages }
    })
    await $.session.compact({ trigger: 'manual', messages: ONE, instructions: 'keep the plan' })
    expect(told).toContain('keep the plan')
    expect(told).toContain('whatever the work:\n- 一律用繁體中文')
    expect(told).toContain('## git\n- [規範] 不要自己 push')
  })

  test('a subagent\'s compaction is left alone', async ($, on) => {
    mock.store(on, { [`context:${ROOT}`]: rules })
    on('session.root', () => ({ value: ROOT }))
    on('session.repo', () => ({ value: null }))
    let told: string | undefined = 'unset'
    on('session.compact', ($, e) => {
      told = e.instructions
      return { messages: e.messages }
    })
    await $.session.compact({ trigger: 'auto', agentId: 'a1', messages: ONE })
    expect(told).toBeUndefined()
  })
})
