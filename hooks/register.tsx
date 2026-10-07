// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand, SHORT_COMMAND, SHORT_COMMAND_SPEC } from './commands'
import { bookmarkNote, change, explainDrop, prepare, readOptions, recordRoute, routePrompt, startNote, type Options } from './notes'
import { PANE_ID, PANE_TITLE, paneView, statusLine } from './pane'
import type { Ports } from './ports'
import { CONTEXT_MARKER, isProbePrompt, longQuestion, PREVIEW_QUESTION, probeCommand, RCPROBE_LOG, RCPROBE_ON } from './rcprobe' // TEMPORARY
import { describeKey, findKey, keyFiles, resolveKey } from './secrets'
import { setActive } from './tree'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const unreadAtom = atom({ plugin: 'cc-sticky-notes', key: 'unread' } as const, 0)
const pendingAtom = atom({ plugin: 'cc-sticky-notes', key: 'pending' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastTurnId' } as const, null)
const turnsAtSidebarAtom = atom({ plugin: 'cc-sticky-notes', key: 'turnsAtLastSidebar' } as const, 0)
const lastPromptAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastPromptUuid' } as const, null)
const lastSampleAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastSampleId' } as const, null)

/** Key files to try after the environment (secrets.ts says which and why). */
async function keyFilesOf($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return keyFiles(home, $.plugin.root)
}

/**
 * The status line under the prompt (the developer's pick, PROBE.md「UI 能放在哪裡」 D):
 * "cc-sticky-note <the question this session follows up>". Redrawn whenever the tree
 * or the pending count changes.
 */
async function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine(await read($, treeAtom), await $.session.id(), await read($, pendingAtom)))
}

function portsOf($: EngineInterface): Ports {
  const readText = (path: string) => $.fs.read(path) as Promise<string>
  return {
    sessionId: () => $.session.id(),
    // PLAN.md: one tree per repo, shared by its worktrees; the session root outside a repo.
    projectRoot: async () => (await $.session.repo())?.root ?? (await $.session.root()),
    turns: () => $.session.turns(),
    messages: async () => {
      const list = await $.session.messages()
      return Array.isArray(list) ? list : []
    },
    now: () => $.clock.now(),
    later: fn => void $.clock.after(0, fn),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    fetch: (url, init) => $.http.fetch(url, init),
    fork: prompt => $.model.fork({ prompt }),
    complete: request => $.model.complete(request),
    keys: {
      typesafe: async () => resolveKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), await keyFilesOf($), readText),
      openai: async () => resolveKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), await keyFilesOf($), readText),
      report: async () => {
        const files = await keyFilesOf($)
        return [
          describeKey('TYPESAFE_API_KEY', await findKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), files, readText)),
          describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), files, readText)),
          `key 檔查找順序：${files.join(' → ')}`,
        ]
      },
    },
    ui: {
      log: (text, to) => $.ui.log(text, { to: to ?? 'transcript' }),
      toast: text => $.ui.toast(text),
      ask: (question, options, header) => $.ui.ask(question, { options, header }),
      openPane: async () => {
        await update($, unreadAtom, () => 0)
        await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      },
      closePane: () => $.ui.close({ id: PANE_ID }),
      isPaneOpen: async () => (await $.ui.panes()).some(pane => pane.id === PANE_ID),
      status: text => $.ui.status(text),
    },
    state: {
      publishTree: async tree => {
        await update($, treeAtom, () => tree)
        await refreshStatus($)
      },
      lastTurnId: () => read($, lastTurnAtom),
      turnsAtLastSidebar: () => read($, turnsAtSidebarAtom),
      setTurnsAtLastSidebar: async n => void (await update($, turnsAtSidebarAtom, () => n)),
      addPending: async delta => {
        await update($, pendingAtom, n => Math.max(0, n + delta))
        await refreshStatus($)
      },
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
      lastPromptUuid: () => read($, lastPromptAtom),
      lastSampleId: () => read($, lastSampleAtom),
      setLastSampleId: async id => void (await update($, lastSampleAtom, () => id)),
      setSelected: async id => void (await update($, selectedAtom, () => id)),
    },
  }
}

/** Pane click: show it and make it this session's activeThread. 回到主線 passes null. */
async function selectNode($: EngineInterface, id: string | null) {
  const p = portsOf($)
  const sessionId = await p.sessionId()
  await update($, selectedAtom, () => id)
  await change(p, t => setActive(t, sessionId, id))
}

/** The pane's follow-up box: straight to a note under that node, no Jev (PLAN.md). */
async function followUp($: EngineInterface, opts: Options, parentId: string, question: string) {
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'under', parentId },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

// ---- TEMPORARY: Remote Control probe (PROBE.md「Remote Control」; delete with rcprobe.ts) ----
let probeOn = false
const probeSeen = new Set<string>()

async function probeLog($: EngineInterface, kind: string, data: unknown) {
  const list = ((await $.store.get(RCPROBE_LOG)) as unknown[] | undefined) ?? []
  list.push({ t: await $.clock.now(), kind, data })
  await $.store.set(RCPROBE_LOG, list.slice(-300))
}

async function probeMark($: EngineInterface, component: string, surface: string) {
  if (probeSeen.has(`${component}@${surface}`)) return
  probeSeen.add(`${component}@${surface}`)
  await probeLog($, 'render', { component, surface })
}

/** Logs a prompt; answers the probe's own drop / ask prompts, or returns null to go on. */
async function probePrompt($: EngineInterface, e: { text: string; origin: unknown; turnId?: string; wait: boolean }) {
  if (!probeOn && !isProbePrompt(e.text)) return null
  await probeLog($, 'prompt.submit', {
    keys: Object.keys(e),
    origin: e.origin,
    turnId: e.turnId ?? null,
    wait: e.wait,
    text: e.text.slice(0, 40),
    surfaces: await $.session.surfaces(),
  })
  const cmd = probeCommand(e.text)
  if (cmd === 'drop') return { drop: 'rcprobe: dropped by prompt.submit ({ drop })' }
  if (cmd !== 'ask' && cmd !== 'askpreview') return null
  $.clock.after(3000, () => {
    void (async () => {
      const t0 = await $.clock.now()
      try {
        if (cmd === 'ask') {
          const q = longQuestion()
          const answer = await $.ui.ask(q, { options: ['收到', '看不到完整問題'], header: 'rcprobe' })
          await probeLog($, 'ui.ask', { answer, ms: (await $.clock.now()) - t0, questionChars: [...q].length })
        } else {
          const r = await $.tool.call({ tool: 'AskUserQuestion', questions: [PREVIEW_QUESTION] } as never)
          await probeLog($, 'AskUserQuestion(tool.call)', { result: r, ms: (await $.clock.now()) - t0 })
        }
      } catch (err) {
        await probeLog($, `${cmd} rejected`, { error: String(err).slice(0, 300), ms: (await $.clock.now()) - t0 })
      }
    })()
  })
  return { drop: `rcprobe: dropped; ${cmd} in 3 s` }
}
// ---- end TEMPORARY ----

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register(COMMAND_SPEC)
    await $.command.register(SHORT_COMMAND_SPEC)
    probeOn = (await $.store.get(RCPROBE_ON)) === true // TEMPORARY
    await $.command.register({ name: 'rcprobe', description: 'TEMP Remote Control probe: on | off | clear', argumentHint: 'on | off | clear' }) // TEMPORARY
    await prepare(portsOf($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // anchor.messageId: the main-line user message a later sidebar question sits after (M2 badge).
    if (e.door === 'prompt' && e.message.type === 'user' && !e.message.isMeta) {
      await update($, lastPromptAtom, () => e.uuid)
      return next(e)
    }
    // PROBE.md P10: `/sticky-note new <問題>` would leave the question in the main context.
    if (e.door === 'command') {
      let masked = false
      const content = e.message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        const text = maskNewArgs(block.text)
        if (text === null) return block
        masked = true
        return { ...block, text }
      })
      if (masked) return next({ ...e, message: { ...e.message, content } })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const probed = await probePrompt($, e) // TEMPORARY
    if (probed !== null) return probed
    if (isProbePrompt(e.text)) {
      // the probe's own prompts skip the router; everything else routes as usual
      const r = await next(e)
      await probeLog($, 'prompt.submit result', { result: r })
      return r
    }
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)

    const p = portsOf($)
    const routed = await routePrompt(p, opts, e.text)
    const keep = (nodeId: string | null) => p.later(() => void recordRoute(p, opts, e.text, routed, nodeId))
    const d = routed.decision
    switch (d.kind) {
      case 'main':
      case 'ask':
        keep(null)
        return next(e)
      case 'project_question':
        keep(await bookmarkNote(p, e.text, d.route))
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        keep(
          await startNote(p, opts, {
            question: e.text,
            attach: { kind: d.attach },
            answerer: d.answerer,
            route: d.route,
            tag: d.tag.kind === 'existing' ? d.tag.tag : undefined,
          }),
        )
        // The drop reason is the transparency line (PROBE.md P2): who decided, how sure, where it went.
        return { drop: explainDrop(e.text, routed) }
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))
  // /sn: the keyboard shortcut for the pane (the status line cannot be clicked; PROBE.md)
  on('command.run', { command: SHORT_COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = {
      tree: await read($, treeAtom),
      selectedId: await read($, selectedAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
    }
    return paneView($.ui.resolve(e), data, {
      select: id => void selectNode($, id),
      back: () => void selectNode($, null),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
    })
  })

  // ---- TEMPORARY: Remote Control probe hooks ----
  on('command.run', { command: 'rcprobe' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'clear') await $.store.set(RCPROBE_LOG, [])
    if (arg === 'on' || arg === 'off') {
      probeOn = arg === 'on'
      await $.store.set(RCPROBE_ON, probeOn)
      probeSeen.clear()
      $.ui.invalidate('ui.render')
    }
    await probeLog($, 'command', { arg, origin: e.origin, surfaces: await $.session.surfaces() })
    $.ui.toast(`rcprobe ${probeOn ? 'on' : 'off'}`)
    return {}
  })
  on('session.attach', async ($, e, next) => {
    await probeLog($, 'session.attach', { e, surfaces: await $.session.surfaces() })
    return next(e)
  })
  on('session.detach', async ($, e, next) => {
    await probeLog($, 'session.detach', { e })
    return next(e)
  })
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (!probeOn && !isProbePrompt(e.prompt)) return next(e)
    await probeLog($, 'classic.UserPromptSubmit', { source: e.source ?? null, prompt: e.prompt.slice(0, 40), keys: Object.keys(e) })
    const r = await next(e)
    if (e.prompt.trimStart().startsWith('rcprobe-suppress')) {
      return { ...r, suppressOriginalPrompt: true, additionalContext: [...(r.additionalContext ?? []), `rcprobe context marker ${CONTEXT_MARKER}`] }
    }
    if (e.prompt.trimStart().startsWith('rcprobe-block')) return { ...r, block: 'rcprobe: blocked by classic.UserPromptSubmit (block)' }
    return r
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!probeOn) return next(e)
    await probeMark($, 'AbovePrompt', e.surface)
    const { Text } = $.ui.resolve(e)
    return <Text>[rcprobe AbovePrompt] surface={e.surface}</Text>
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!probeOn) return next(e)
    await probeMark($, 'PromptHint', e.surface)
    const { Text } = $.ui.resolve(e)
    return <Text>[rcprobe PromptHint] surface={e.surface}</Text>
  })
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (probeOn) await probeMark($, 'UserMessage', e.surface)
    return next(e)
  })
  // ---- end TEMPORARY ----
}
