// M0 probe. Every line it logs starts with "PROBE " so the stream-json output can be grepped.
// Driven by the prompt prefix: "probe-<name> <rest>". Unknown prompts pass through.
import type { Register } from 'claude-code'

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const out = (s: string) => $.ui.log(`PROBE ${s}`)
    out(`session.start e=${JSON.stringify(e)}`)
    out(`version=${JSON.stringify(await $.session.version())}`)
    out(`id=${await $.session.id()} root=${await $.session.root()} cwd=${await $.session.cwd()}`)
    out(`surfaces=${JSON.stringify(await $.session.surfaces())} plugin.root=${$.plugin.root}`)
    out(`env TYPESAFE_API_KEY set=${(await $.env.get('TYPESAFE_API_KEY')) !== undefined}`)
    out(`env OPENAI_API_KEY set=${(await $.env.get('OPENAI_API_KEY')) !== undefined}`)
    // store: who was here before (cross-session persistence)
    const id = await $.session.id()
    const visits = ((await $.store.get('visits')) as string[] | undefined) ?? []
    out(`store visits(before)=${JSON.stringify(visits)}`)
    await $.store.set('visits', [...visits, id].slice(-10))
    await $.store.set(`mark:${id}`, await $.clock.now())
    out(`store keys=${JSON.stringify(await $.store.keys())}`)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    $.ui.log(`PROBE turn.start turnId=${e.turnId} text=${JSON.stringify(e.text.slice(0, 60))}`)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    $.ui.log(`PROBE turn.complete keys=${Object.keys(e).join(',')}`)
    // second look at the store: did a concurrent session write meanwhile?
    $.ui.log(`PROBE store keys at turn.complete=${JSON.stringify(await $.store.keys())}`)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const out = (s: string) => $.ui.log(`PROBE ${s}`)
    out(`prompt.submit keys=${Object.keys(e).join(',')} turnId=${e.turnId} wait=${e.wait} origin=${JSON.stringify(e.origin)}`)
    const m = /^probe-([a-z-]+)\s*([\s\S]*)$/.exec(e.text)
    if (!m) return next(e)
    const [, name, rest] = m
    const t0 = await $.clock.now()
    const ms = async () => (await $.clock.now()) - t0

    switch (name) {
      case 'drop':
        return { drop: 'cc-sticky-probe: dropped on purpose' }

      case 'fork': {
        const r = await $.model.fork({ prompt: rest || 'In one sentence: what is TCP backpressure?' })
        out(`fork ms=${await ms()} result=${JSON.stringify(r).slice(0, 600)}`)
        return { drop: 'cc-sticky-probe: fork answered off the transcript' }
      }

      case 'fork-history': {
        // Can a fork carry side-thread history? Only via the prompt text (ModelForkRequest is { prompt }).
        const history = 'Q1: What is TCP backpressure?\nA1: When a receiver is slower than a sender, buffers fill and the sender is told to slow down.\n'
        const r = await $.model.fork({ prompt: `[side thread so far]\n${history}\n[follow-up]\n${rest || 'How does that relate to Node streams? One sentence.'}` })
        out(`fork-history ms=${await ms()} result=${JSON.stringify(r).slice(0, 600)}`)
        return { drop: 'cc-sticky-probe: fork-history done' }
      }

      case 'fork-bg': {
        // Drop first, answer in the background.
        $.clock.after(0, async () => {
          const r = await $.model.fork({ prompt: rest || 'One sentence: what is a hash map?' })
          $.ui.log(`PROBE fork-bg ms=${(await $.clock.now()) - t0} result=${JSON.stringify(r).slice(0, 400)}`)
        })
        return { drop: 'cc-sticky-probe: fork-bg scheduled' }
      }

      case 'complete': {
        const r = await $.model.complete({
          model: 'haiku',
          effort: 'low',
          system: 'Reply with a JSON object {"title": string (<=12 chars), "summary": string (3 sentences)}.',
          prompt: rest || 'Q: What is TCP backpressure? A: Receiver slower than sender, sender slows down.',
          maxTokens: 300,
          timeoutMs: 20000,
        })
        out(`complete ms=${await ms()} result=${JSON.stringify(r).slice(0, 600)}`)
        return { drop: 'cc-sticky-probe: complete done' }
      }

      case 'classify': {
        try {
          const label = await $.model.classify(rest || 'why does TCP need a three-way handshake?', [
            'main_task', 'sidebar_knowledge', 'project_question',
          ])
          out(`classify ms=${await ms()} label=${JSON.stringify(label)}`)
        } catch (err) {
          out(`classify threw ${String(err)}`)
        }
        return { drop: 'cc-sticky-probe: classify done' }
      }

      case 'messages': {
        const msgs = await $.session.messages()
        if (Array.isArray(msgs)) {
          out(`messages n=${msgs.length}`)
          for (const one of msgs.slice(-4)) {
            out(`  msg role=${one.role} keys=${Object.keys(one).join(',')} text=${JSON.stringify(one.text.slice(0, 80))} toolUses=${one.toolUses.length}`)
          }
        } else out(`messages deny=${JSON.stringify(msgs)}`)
        out(`turns=${await $.session.turns()} usage=${JSON.stringify(await $.session.usage()).slice(0, 400)}`)
        return { drop: 'cc-sticky-probe: messages done' }
      }

      case 'http': {
        for (const url of ['https://api.openai.com/v1/models', 'https://api.typesafe.ai/v1/systemone']) {
          try {
            const r = await $.http.fetch(url, { method: url.includes('typesafe') ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: url.includes('typesafe') ? '{}' : undefined })
            out(`http ${url} status=${r.status} ok=${r.ok} headerKeys=${Object.keys(r.headers).slice(0, 8).join(',')} text=${JSON.stringify(r.text.slice(0, 200))}`)
          } catch (err) {
            out(`http ${url} threw ${String(err)}`)
          }
        }
        return { drop: 'cc-sticky-probe: http done' }
      }

      case 'jev': {
        // Real Jev call with the four PLAN.md questions; logs the raw response.
        const key = await $.env.get('TYPESAFE_API_KEY')
        if (!key) {
          out('jev: no TYPESAFE_API_KEY')
          return { drop: 'cc-sticky-probe: jev skipped' }
        }
        const prompt = rest || 'TCP 的 backpressure 是什麼原理？'
        const body = {
          model: 'jev-latest',
          state: `[recent main-line context]\nuser: 把 auth 改成 session cookie\nassistant: 已改好，剩 token 輪替。\n\n[sidebar state]\nactive_thread_title: none\nactive_thread_last_question: none\nmain_turns_since_last_sidebar: 2\n\n[new prompt]\n${prompt}`,
          questions: {
            route: {
              type: 'choice',
              instructions: 'Where should the new prompt go?',
              criteria: {
                main_task: 'Advances the project: an instruction, a code change, or a decision about what Claude just did',
                sidebar_knowledge: 'Asks about a principle, concept or background knowledge; does not ask Claude to change anything',
                project_question: 'A question about this project itself whose answer belongs in the main conversation',
              },
            },
            is_followup: { type: 'noul', instructions: 'Does the new prompt continue the topic of active_thread?' },
            needs_project_ctx: { type: 'noul', instructions: "Does answering the new prompt require seeing the project's code or conversation?" },
            tag: { type: 'choice', instructions: 'Which topic tag fits the new prompt?', criteria: { network: 'About network', db: 'About db', __new__: 'None of the existing tags fits' } },
          },
        }
        const r = await $.http.fetch('https://api.typesafe.ai/v1/systemone', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify(body),
        })
        out(`jev ms=${await ms()} status=${r.status} text=${r.text.slice(0, 1500)}`)
        return { drop: 'cc-sticky-probe: jev done' }
      }

      case 'openai': {
        const key = await $.env.get('OPENAI_API_KEY')
        if (!key) {
          out('openai: no OPENAI_API_KEY')
          return { drop: 'cc-sticky-probe: openai skipped' }
        }
        const r = await $.http.fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: rest || 'gpt-5-mini',
            max_completion_tokens: 400,
            reasoning_effort: 'minimal',
            messages: [
              { role: 'system', content: 'Reply with JSON only: {"title": "<=12 chars", "summary": "three sentences"}' },
              { role: 'user', content: 'Q: What is TCP backpressure? A: When the receiver is slower, buffers fill and the sender slows down.' },
            ],
          }),
        })
        out(`openai ms=${await ms()} status=${r.status} text=${r.text.slice(0, 1500)}`)
        return { drop: 'cc-sticky-probe: openai done' }
      }

      case 'agents': {
        try {
          const r = await $.tool.call({ tool: 'ListAgents' })
          out(`ListAgents result=${JSON.stringify(r).slice(0, 800)}`)
        } catch (err) {
          out(`ListAgents threw ${String(err)}`)
        }
        return { drop: 'cc-sticky-probe: agents done' }
      }

      case 'suggest': {
        const r = await $.prompt.suggest({ text: '正在追問：probe' })
        out(`suggest result=${JSON.stringify(r)}`)
        return { drop: 'cc-sticky-probe: suggest done' }
      }

      case 'store-race': {
        // Two processes run this at once. Separate keys + one shared read-modify-write key.
        const id = await $.session.id()
        await $.store.set(`race:${id}`, t0)
        const before = ((await $.store.get('race-list')) as string[] | undefined) ?? []
        await $.clock.sleep(3000)
        await $.store.set('race-list', [...before, id])
        out(`store-race id=${id} keysAfter=${JSON.stringify((await $.store.keys()).filter(k => k.startsWith('race')))} list=${JSON.stringify(await $.store.get('race-list'))}`)
        return { drop: 'cc-sticky-probe: store-race done' }
      }

      case 'store-read': {
        out(`store-read keys=${JSON.stringify((await $.store.keys()).filter(k => k.startsWith('race')))} list=${JSON.stringify(await $.store.get('race-list'))}`)
        return { drop: 'cc-sticky-probe: store-read done' }
      }

      case 'budget': {
        // Does a long $ call count against the 10 s budget? $.clock.sleep does; http does not.
        try {
          await $.http.fetch('https://httpbin.org/delay/12')
          out(`budget http 12s ok ms=${await ms()}`)
        } catch (err) {
          out(`budget http threw ${String(err)} ms=${await ms()}`)
        }
        return { drop: 'cc-sticky-probe: budget done' }
      }

      case 'context': {
        // project_question path: pass through with extra context
        return next({ ...e, text: rest ?? '', context: [...(e.context ?? []), '[sticky-notes] project question; answer briefly'] })
      }

      default:
        return next(e)
    }
  })

  // UI probe: a badge beside the original user row, and a hotkey the type says is refused.
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!e.props.text.includes('badge-me')) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    const original = await next(e)
    return (
      <Box flexDirection="row">
        {original}
        <Button key="badge" plain label="📌 1" onPress={() => $.ui.toast('badge pressed')} />
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="alt" label="open" hotkey="⌥s" onPress={() => {}} />
      </Box>
    )
  })
}
