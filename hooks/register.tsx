// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, HttpResponse, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand, SHORT_COMMAND, SHORT_COMMAND_SPEC } from './commands'
import { applyOptionOverrides, change, digestNow, optionKey, projectKey, explainDrop, prepare, readOptions, recordFeedback, routePrompt, startNote, type Options } from './notes'
import { PANE_ID, PANE_TITLE, paneView } from './pane'
import { addFacts, contextKey, readDigest, readFacts, type ContextFact } from './context'
import type { Ports } from './ports'
import { describeKey, findKey, keyFiles, resolveKey } from './secrets'
import { setActive } from './tree'
import { addUsage, claudeDelta, fetchDelta, readUsage, usageLine, type Usage } from './usage'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const editingAtom = atom({ plugin: 'cc-sticky-notes', key: 'editingId' } as const, null)
const contextRevAtom = atom({ plugin: 'cc-sticky-notes', key: 'contextRev' } as const, 0)
const digestStatusAtom = atom({ plugin: 'cc-sticky-notes', key: 'digestStatus' } as const, { running: false, at: null, result: null })
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

const kvOf = ($: EngineInterface) => ({
  get: (key: string) => $.store.get(key),
  set: (key: string, value: never) => $.store.set(key, value),
  delete: (key: string) => $.store.delete(key),
  keys: () => $.store.keys(),
})

/**
 * The status line under the prompt (PROBE.md「UI 能放在哪裡」 D): what this mod spent
 * today (usage.ts), and the answers still pending. Desktop draws the plugin's name
 * before it. Redrawn when a count, the tree or the pending number changes.
 */
async function refreshStatus($: EngineInterface) {
  $.ui.status(usageLine(await readUsage(kvOf($), new Date()), await read($, pendingAtom)))
}

/** Adds one request's cost to today's count; a failure to count never fails the request. */
function count($: EngineInterface, delta: Partial<Usage>) {
  if (Object.keys(delta).length === 0) return
  void addUsage(kvOf($), new Date(), delta)
    .then(() => refreshStatus($))
    .catch(() => {})
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
    store: kvOf($),
    // every request that costs a quota is counted as it leaves (usage.ts)
    fetch: async (url, init) => {
      let r: HttpResponse | null = null
      try {
        r = await $.http.fetch(url, init)
        return r
      } finally {
        count($, fetchDelta(url, r))
      }
    },
    fork: async prompt => {
      const r = await $.model.fork({ prompt })
      if ('usage' in r) count($, claudeDelta(r.usage))
      return r
    },
    complete: async request => {
      const r = await $.model.complete(request)
      count($, claudeDelta(r.usage))
      return r
    },
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
    mcp: {
      tools: async () => (await $.tool.list()).filter(t => t.mcp).map(t => t.name),
      call: async (server, tool, args) => {
        const r = await $.mcp.call(server, tool, args)
        return { isError: r.isError, content: r.content as { type: string; text?: string }[] }
      },
    },
    setOption: async (field, value) => {
      try {
        // the row of this plugin's own field: `cc-sticky-notes.<field>` (or `cc-sticky-notes@inline.<field>`)
        // kept in this machine's store too, applied at session.start (applyOptionOverrides): a
        // --plugin-dir mod's fields are not rows of /config (seen 10/14), so that is the one that holds
        await $.store.set(optionKey(field), value)
        const row = (await $.config.list()).find(r => /^cc-sticky-notes(@[^.]+)?\./.test(r.key) && r.key.endsWith(`.${field}`))
        if (!row) return { ok: true }
        const r = await $.config.set({ key: row.key, value: value as never })
        if (r.deny !== undefined) $.ui.log(`sticky-notes: /config kept ${field} as it was (${r.deny}); this machine's own setting stands`, { to: 'debug' })
        return { ok: true }
      } catch (err) {
        return { ok: false, reason: String(err).slice(0, 200) }
      }
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
      contextChanged: async () => void (await update($, contextRevAtom, n => n + 1)),
      setDigestStatus: async (running, result) =>
        void (await update($, digestStatusAtom, s => (running ? { ...s, running: true } : { running: false, at: Date.now(), result }))),
    },
  }
}

/**
 * A card press: opens the card holding this note (null closes). Reading a card does not
 * make it the one this session follows up (10/14): a reply does, or the dialog's pick.
 */
async function selectNode($: EngineInterface, id: string | null) {
  await update($, editingAtom, () => null)
  await update($, selectedAtom, () => id)
}

/** R4: what the project context card shows; read on each draw (contextRev makes it draw again). */
async function contextData($: EngineInterface, opts: Options) {
  await read($, contextRevAtom)
  const how = { digestEvery: opts.digestEvery, provider: opts.summaryProvider, digestStatus: await read($, digestStatusAtom) }
  try {
    const p = portsOf($)
    const root = await projectKey(p)
    const facts = await readFacts(p.store, root)
    const digest = (await readDigest(p.store, root, await p.sessionId()))?.text ?? null
    return { ...how, digest, facts: facts.map(f => ({ id: f.id, text: f.text, source: f.source })) }
  } catch {
    // never let the context card refuse the whole pane
    return { ...how, digest: null, facts: [] }
  }
}

/** R4: the pane's edits to the project context. */
async function editFacts($: EngineInterface, edit: (facts: ContextFact[]) => ContextFact[]) {
  const p = portsOf($)
  const root = await projectKey(p)
  await p.store.set(contextKey(root), edit(await readFacts(p.store, root)))
  await p.state.contextChanged()
}

/** 結束追問 on the green card: this session follows up no note. */
async function unfollow($: EngineInterface) {
  const p = portsOf($)
  const sessionId = await p.sessionId()
  await change(p, t => setActive(t, sessionId, null))
}

/**
 * ✎: a rewritten question is asked again beside the old one — a new follow-up of the
 * same parent, so the parent's answer offers both; a first question starts a new topic.
 */
async function rewrite($: EngineInterface, opts: Options, nodeId: string, question: string) {
  const tree = await read($, treeAtom)
  const parentId = tree?.nodes[nodeId]?.parentId ?? null
  if (parentId !== null) return followUp($, opts, parentId, question)
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'root' },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

/** The pane's reply box: straight to a note under that node, no Jev (PLAN.md). */
async function followUp($: EngineInterface, opts: Options, parentId: string, question: string) {
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'under', parentId },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await applyOptionOverrides(kvOf($), opts)
    await $.command.register(COMMAND_SPEC)
    await $.command.register(SHORT_COMMAND_SPEC)
    await prepare(portsOf($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    return next(e)
  })

  // R4: every digestEvery main turns, the main-line digest and the project context, in the background
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && opts.digestEvery > 0) {
      const p = portsOf($)
      p.later(() => void digestNow(p, opts).catch(err => p.ui.log(`sticky-notes: main digest failed: ${String(err).slice(0, 200)}`, 'debug')))
    }
    return r
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
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)

    const p = portsOf($)
    const routed = await routePrompt(p, opts, e.text, { remote: e.origin.kind === 'bridge' })
    const keep = (nodeId: string | null) => p.later(() => void recordFeedback(p, opts, e.text, routed, nodeId))
    const d = routed.decision
    switch (d.kind) {
      case 'main':
      case 'ask':
        keep(null)
        return next(e)
      case 'project_question':
        // the main line answers it; no note (going to the main line means no note)
        keep(null)
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        keep(
          await startNote(p, opts, {
            question: e.text,
            attach: d.parentId !== undefined ? { kind: 'under', parentId: d.parentId } : { kind: d.attach },
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
      editingId: await read($, editingAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
      surface: e.surface,
      ...(await contextData($, opts)),
    }
    return paneView($.ui.resolve(e), data, {
      select: id => void selectNode($, id),
      edit: id => void update($, editingAtom, () => id),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
      rewrite: (nodeId, question) => void rewrite($, opts, nodeId, question),
      unfollow: () => void unfollow($),
      addFact: text =>
        void $.session.id().then(sessionId => editFacts($, facts => addFacts(facts, [{ id: crypto.randomUUID(), text, at: Date.now(), sessionId, source: 'manual' }]))),
      removeFact: id => void editFacts($, facts => facts.filter(f => f.id !== id)),
      // the card itself shows 統整中… and then the outcome (digestStatus)
      refreshDigest: () => {
        const p = portsOf($)
        p.later(() => void digestNow(p, opts, true))
      },
    })
  })
}
