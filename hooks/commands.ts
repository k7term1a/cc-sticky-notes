// /sticky-note and its subcommands.
// A command's `{ text }` is a transcript row the model also reads, so anything
// long or private goes to $.ui.log / toast instead and the command returns {}.
import type { CommandRunResult } from 'claude-code'

import { addFacts, contextKey, readDigest, readFacts } from './context'
import { calibrate, formatCalibration, listRecords, parseFeedback } from './feedback'
import { notionProbe } from './notion'
import { change, confirmDelete, digestNow, digestWords, dropReason, syncPull, syncPushAll, syncStatus, giveFeedback, projectKey, startNote, type Options } from './notes'
import type { Ports } from './ports'
import { setActive } from './tree'

export const COMMAND = 'sticky-note'

export const COMMAND_SPEC = {
  name: COMMAND,
  description: 'Sticky Notes: open/close the pane, or new | back | rm | timeout | provider | every | ctx | notion | feedback | calibrate | doctor',
  argumentHint: '[new <問題> | back | provider claude|openai | every <n> | ctx [add <文字> | rm <n> | refresh] | feedback … | calibrate]',
}

const CHOICE_NAME = { main: '主線', new: '新的便利貼', followup: '追問' } as const

/**
 * /sn: the keyboard way to the pane. The status line cannot be clicked, a plugin
 * button's hotkey works only while its site has the focus, and keybindings.json
 * has no "run a command" action (PROBE.md), so a two-letter command is the shortcut.
 * Takes the same subcommands as /sticky-note.
 */
export const SHORT_COMMAND = 'sn'

export const SHORT_COMMAND_SPEC = {
  name: SHORT_COMMAND,
  description: 'Sticky Notes: open/close the pane (short for /sticky-note)',
  argumentHint: '[new <問題> | back | provider claude|openai | every <n> | ctx …]',
}

const LATER: Record<string, string> = {
  promote: 'M2',
  outline: 'M3',
  refresh: 'M3',
  digest: 'M3',
  export: 'M3',
  mode: 'M4',
  stats: 'M4',
}

export function parseArgs(args: string): { sub: string; rest: string } {
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(args)
  return { sub: (m?.[1] ?? '').toLowerCase(), rest: (m?.[2] ?? '').trim() }
}

/** The args a /sticky-note new record keeps in the transcript (PROBE.md P10). */
export const NEW_ARGS_MASK = 'new (sticky note)'

/**
 * Rewrites the transcript record of `/sticky-note new <問題>` so the question
 * does not stay in the main context. Returns null when the text is not that record.
 */
export function maskNewArgs(text: string): string | null {
  if (!text.includes(`<command-name>/${COMMAND}</command-name>`) && !text.includes(`<command-name>/${SHORT_COMMAND}</command-name>`)) return null
  const re = /<command-args>\s*new\b[\s\S]*?<\/command-args>/
  return re.test(text) ? text.replace(re, `<command-args>${NEW_ARGS_MASK}</command-args>`) : null
}

export async function runCommand(p: Ports, opts: Options, args: string): Promise<CommandRunResult> {
  const { sub, rest } = parseArgs(args)
  switch (sub) {
    case '': {
      if (await p.ui.isPaneOpen()) await p.ui.closePane()
      else await p.ui.openPane()
      return {}
    }
    case 'new': {
      if (rest === '') return { text: '用法：/sticky-note new <問題>' }
      await startNote(p, opts, {
        question: rest,
        attach: { kind: 'root' },
        answerer: 'fork',
        route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
      })
      p.ui.toast(dropReason(rest))
      return {}
    }
    case 'rm': {
      // the note the pane has open (its thread runs through it), as ✕ does
      const id = await p.state.selected()
      if (id === null || id === '__context__') return { text: '先在 pane 點開要刪的便利貼（或在問題旁按 ✕）' }
      const n = await confirmDelete(p, opts, id)
      return n > 0 ? {} : { text: '沒有刪除' }
    }
    case 'timeout': {
      // seconds the Jev dialog waits before the prompt goes to the main line; 0 waits forever
      if (rest === '') return { text: opts.askTimeout > 0 ? `對話框 ${opts.askTimeout} 秒沒回應就送進主線。調整：/sn timeout <秒>（0 = 一直等）` : '對話框會一直等到你回答。調整：/sn timeout <秒>' }
      const n = Number(rest)
      if (!Number.isInteger(n) || n < 0 || n > 600) return { text: '用法：/sn timeout <0–600 的整數秒數>（0 = 一直等）' }
      const r = await p.setOption('askTimeout', n)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.askTimeout = n
      p.ui.toast(n > 0 ? `Sticky Notes：對話框 ${n} 秒沒回應就送進主線` : 'Sticky Notes：對話框會一直等')
      return {}
    }
    case 'back': {
      const sessionId = await p.sessionId()
      await change(p, t => setActive(t, sessionId, null))
      return {}
    }
    case 'feedback': {
      const fb = parseFeedback(rest)
      if (fb === null) return { text: '用法：/sn feedback main|new|followup（這句應該是什麼），或 good（現在這樣就對）' }
      const record = await giveFeedback(p, fb)
      p.ui.toast(record ? `已記下：上一句應該是 ${CHOICE_NAME[record.choice ?? 'main']}` : '這個 session 還沒有可以回饋的路由紀錄')
      return {}
    }
    case 'notion': {
      // /sn notion <collection://… or a database URL>: where the notes sync; /sn notion test: can the mod reach it
      const [verb = ''] = rest.split(/\s+/)
      if (verb === 'test') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        return { text: ['Notion 測試：', ...(await notionProbe(p, opts.notionDataSource))].join('\n') }
      }
      if (verb === 'pull' || verb === 'push') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        if (verb === 'pull') return { text: `Notion：${await syncPull(p, opts)}` }
        const r = await syncPushAll(p, opts)
        return { text: `Notion：上傳 ${r.pushed} 張${r.failed ? `，${r.failed} 張失敗（/sn notion 看原因）` : ''}` }
      }
      if (verb === '') {
        if (opts.notionDataSource === '') return { text: '還沒設定 Notion 資料庫：/sn notion <collection://…>' }
        return { text: `便利貼同步到：${opts.notionDataSource}\n上次：${(await syncStatus(p)) ?? '還沒同步過'}\n指令：/sn notion pull（下載）、/sn notion push（把這個專案還沒上傳的都上傳）、/sn notion test` }
      }
      if (!/^collection:\/\/[0-9a-f-]{32,36}$/.test(verb)) return { text: '用法：/sn notion <collection://…> | test | pull | push' }
      const r = await p.setOption('notionDataSource', verb)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.notionDataSource = verb
      return { text: '已設定 Notion 資料庫。打 /sn notion test 確認 mod 連得到。' }
    }
    case 'doctor': {
      for (const line of await p.keys.report()) p.ui.log(line)
      return {}
    }
    case 'provider': {
      // the summary layer: titles, summaries, the main digest (Claude subscription or OpenAI free tier)
      const v = rest.toLowerCase()
      if (v === '') return { text: `統整層目前用 ${opts.summaryProvider === 'openai' ? 'OpenAI' : 'Claude'}。切換：/sn provider claude 或 /sn provider openai` }
      if (v !== 'claude' && v !== 'openai') return { text: '用法：/sn provider claude|openai' }
      const r = await p.setOption('summaryProvider', v)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.summaryProvider = v
      p.ui.toast(`Sticky Notes：統整層改用 ${v === 'claude' ? 'Claude' : 'OpenAI'}`)
      return {}
    }
    case 'every': {
      // R4: the main-line digest and the project context every n main turns; 0 turns them off
      if (rest === '') return { text: `目前${opts.digestEvery > 0 ? `每 ${opts.digestEvery} 回合背景統整一次` : '不做背景統整'}。調整：/sn every <回合數>（0 = 關閉）` }
      const n = Number(rest)
      if (!Number.isInteger(n) || n < 0 || n > 100) return { text: '用法：/sn every <0–100 的整數>（0 = 關閉）' }
      const r = await p.setOption('digestEvery', n)
      if (!r.ok) return { text: `沒有改成功：${r.reason}` }
      opts.digestEvery = n
      p.ui.toast(n > 0 ? `Sticky Notes：每 ${n} 回合背景統整一次` : 'Sticky Notes：背景統整已關閉')
      return {}
    }
    case 'ctx': {
      // R4: the project context (only ever added to by the summary layer) and this session's digest
      const root = await projectKey(p)
      const [verb = '', ...words] = rest.split(/\s+/)
      const arg = words.join(' ').trim()
      const facts = await readFacts(p.store, root)
      if (verb === 'add') {
        if (arg === '') return { text: '用法：/sn ctx add <一條專案脈絡>' }
        const fact = { id: crypto.randomUUID(), text: [...arg].slice(0, 200).join(''), at: await p.now(), sessionId: await p.sessionId(), source: 'manual' as const }
        await p.store.set(contextKey(root), addFacts(facts, [fact]))
        await p.state.contextChanged()
        p.ui.toast('Sticky Notes：已加入專案脈絡')
        return {}
      }
      if (verb === 'rm') {
        const i = Number(arg) - 1
        if (!Number.isInteger(i) || i < 0 || i >= facts.length) return { text: `用法：/sn ctx rm <1–${facts.length}>` }
        await p.store.set(contextKey(root), facts.filter((_, k) => k !== i))
        await p.state.contextChanged()
        p.ui.toast(`Sticky Notes：已刪除第 ${i + 1} 條`)
        return {}
      }
      if (verb === 'refresh') {
        p.ui.toast('Sticky Notes：背景統整中…（結果會顯示在 pane 的「專案脈絡」卡片）')
        p.later(() => void digestNow(p, opts, true).then(r => p.ui.toast(`Sticky Notes：${digestWords(r)}`)))
        return {}
      }
      if (verb !== '') return { text: '用法：/sn ctx [add <文字> | rm <n> | refresh]' }
      // the list stays out of the transcript (a command's text is a row the model reads)
      const digest = await readDigest(p.store, root, await p.sessionId())
      p.ui.log(`主線摘要（這個 session）：${digest?.text ?? '還沒有'}`)
      if (facts.length === 0) p.ui.log('專案脈絡：還沒有。背景統整會自動加，或用 /sn ctx add <文字>')
      facts.forEach((f, k) => p.ui.log(`${k + 1}. ${f.text}${f.source === 'manual' ? '（手動）' : ''}`))
      return {}
    }
    case 'calibrate': {
      const lines = formatCalibration(calibrate(await listRecords(p.store, await projectKey(p))))
      for (const line of lines) p.ui.log(line)
      return {}
    }
    default: {
      const when = LATER[sub]
      return { text: when ? `/sticky-note ${sub}：尚未實作（${when}）` : `未知的子指令：${sub}` }
    }
  }
}
