// Notion sync (REQUESTS.md R5 / remote, 10/14): the notes of every computer in one Notion
// database, reached through the claude.ai Notion connector ($.mcp.call), so no token sits
// in the mod; the permission rules for its four tools are the user's own (README).
import type { Tree, TreeNode } from '../types'
import type { Ports } from './ports'
import { addNode, updateNode } from './tree'

/** The claude.ai connector's server, by the spelling its tools carry: mcp__<server>__notion-fetch. */
export function notionServer(toolNames: readonly string[]): string | null {
  for (const n of toolNames) {
    const m = /^mcp__(.+)__notion-fetch$/.exec(n)
    if (m) return m[1]!
  }
  return null
}

/** The text of an MCP result, its text blocks joined. */
export function resultText(r: { content: readonly { type: string; text?: string }[] }): string {
  return r.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

/**
 * /sn notion test: can this mod reach the Notion connector, read the database's
 * schema, and write and read one row? Each step says how it went, short enough for
 * a command's output (the only thing a Remote Control client sees).
 */
export async function notionProbe(p: Ports, dataSource: string): Promise<string[]> {
  const out: string[] = []
  const server = notionServer(await p.mcp.tools())
  if (server === null) return ['✗ 找不到 Notion connector（mcp__*__notion-fetch）']
  out.push(`✓ connector：${server}`)
  try {
    const schema = await p.mcp.call(server, 'notion-fetch', { id: dataSource })
    const text = resultText(schema)
    out.push(schema.isError ? `✗ 讀資料庫：${text.slice(0, 160)}` : `✓ 讀資料庫：${text.includes('Note ID') ? '欄位都在' : '欄位不對'}（${text.length} 字）`)
    if (schema.isError) return out
    const id = `probe-${Date.now()}`
    const made = await p.mcp.call(server, 'notion-create-pages', {
      parent: { data_source_id: dataSource.replace(/^collection:\/\//, '') },
      allow_async: false,
      pages: [{ properties: { 標題: '探針測試（可刪）', 'Note ID': id, 問題: 'mod 寫得進來嗎？' }, content: '這一列是 /sn notion test 寫的，可以刪掉。' }],
    })
    out.push(made.isError ? `✗ 寫一列：${resultText(made).slice(0, 160)}` : '✓ 寫一列')
    if (made.isError) return out
    const rows = await p.mcp.call(server, 'notion-query-data-sources', {
      data: {
        mode: 'rows',
        data_source_url: dataSource,
        filter: { type: 'group', operator: 'and', filters: [{ type: 'property', property: 'Note ID', propertyType: 'text', operator: 'string_is', value: { type: 'exact', value: id } }] },
        limit: 5,
      },
    })
    const back = resultText(rows)
    out.push(rows.isError ? `✗ 讀回來：${back.slice(0, 160)}` : back.includes(id) ? '✓ 讀回來' : `✗ 讀回來找不到那一列：${back.slice(0, 160)}`)
  } catch (err) {
    out.push(`✗ 呼叫失敗：${String(err).slice(0, 200)}`)
  }
  return out
}

// ---- the sync (10/14): one Notion row per answered note; other computers' rows pulled in ----
//
//   push: answerNote → pushNote, once the answer and its title are in (one create-pages call)
//   pull: session.start and /sn notion pull → pullNotes (one query, one fetch per new note)
//   $.store notion:<root>:<nodeId> → the row's URL: pushed from here, or pulled from there
//   $.store notion-pull:<root>      → the newest 建立時間 pulled, so the next query asks for newer only
// Two computers never edit the same note (the developer, 10/14): no merging, a row is written once.

/** The cross-computer name of a project: its git remote without scheme, user and .git; else the folder's name. */
export function projectName(remote: string | null, root: string): string {
  if (remote) {
    const r = remote
      .trim()
      .replace(/^[a-z+]+:\/\//i, '')
      .replace(/^[^@/]+@/, '')
      .replace(/:(?!\d)/, '/')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
      .toLowerCase()
    if (r !== '') return r
  }
  return root.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) ?? root
}

const notionKey = (root: string, id: string) => `notion:${root}:${id}`
const pullKey = (root: string) => `notion-pull:${root}`
const cut = (s: string, n: number) => [...s].slice(0, n).join('')
/** A rich-text property holds 2000 characters. */
const PROP_MAX = 1900
/** The answer as the page's content; long answers are cut with a note. */
const BODY_MAX = 40000

/** The JSON a tool answered with (its text, or the object a text holds). */
function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** The first Notion page URL in a create-pages answer. */
export function pageUrl(text: string): string | null {
  return /https:\/\/(?:app\.notion\.com|www\.notion\.so)\/[^\s"'<>)]+/.exec(text)?.[0]?.replace(/\?.*$/, '') ?? null
}

/** A fetched page's content: between <content> and </content>, in the fetch answer's `text`. */
export function pageContent(text: string): string {
  const o = jsonOf(text) as { text?: unknown } | null
  const body = o && typeof o.text === 'string' ? o.text : text
  const m = /<content>\n?([\s\S]*?)\n?<\/content>/.exec(body)
  return m ? m[1]!.trim() : ''
}

export type NotionRow = {
  url: string
  noteId: string
  parentId: string | null
  title: string
  question: string
  summary: string
  answeredBy: string
  machine: string
  at: number
}

/** A rows-mode query answer → its rows; rows without a Note ID (or the probe's) are left out. */
export function parseRows(text: string): NotionRow[] {
  const o = jsonOf(text) as { results?: unknown } | null
  const list = o && Array.isArray(o.results) ? (o.results as Record<string, unknown>[]) : []
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  return list
    .map(r => ({
      url: s(r.url),
      noteId: s(r['Note ID']),
      parentId: s(r['上一層']) || null,
      title: s(r['標題']),
      question: s(r['問題']),
      summary: s(r['摘要']),
      answeredBy: s(r['回答者']),
      machine: s(r['電腦']),
      at: Date.parse(s(r['date:建立時間:start'])) || 0,
    }))
    .filter(r => r.noteId !== '' && !r.noteId.startsWith('probe-'))
}

export type SyncPorts = Ports & { place(): Promise<{ remote: string | null; machine: string }>; projectKey(): Promise<string> }

async function serverOf(p: Ports): Promise<string | null> {
  return notionServer(await p.mcp.tools())
}

/**
 * Writes one answered note as a row (properties: the question and its metadata; content:
 * the answer). Once per note: a note already pushed or pulled is left alone. Never throws.
 */
export async function pushNote(p: SyncPorts, dataSource: string, node: TreeNode): Promise<'pushed' | 'skipped' | string> {
  if (dataSource === '' || node.answer === '') return 'skipped'
  const root = await p.projectKey()
  if ((await p.store.get(notionKey(root, node.id))) !== undefined) return 'skipped'
  try {
    const server = await serverOf(p)
    if (server === null) return 'no connector'
    const { remote, machine } = await p.place()
    const answer = [...node.answer].length > BODY_MAX ? `${cut(node.answer, BODY_MAX)}\n\n（答案太長，只同步前 ${BODY_MAX} 字）` : node.answer
    const r = await p.mcp.call(server, 'notion-create-pages', {
      parent: { data_source_id: dataSource.replace(/^collection:\/\//, '') },
      allow_async: false,
      pages: [
        {
          properties: {
            標題: node.title,
            問題: cut(node.question, PROP_MAX),
            摘要: cut(node.summary ?? '', PROP_MAX),
            專案: projectName(remote, root),
            'Note ID': node.id,
            上一層: node.parentId ?? '',
            電腦: machine,
            回答者: node.answeredBy,
            'date:建立時間:start': new Date(node.anchor.at).toISOString(),
            'date:建立時間:is_datetime': 1,
          },
          content: answer,
        },
      ],
    })
    const text = resultText(r)
    if (r.isError) return `error ${text.slice(0, 160)}`
    await p.store.set(notionKey(root, node.id), pageUrl(text) ?? 'pushed')
    return 'pushed'
  } catch (err) {
    return `error ${String(err).slice(0, 160)}`
  }
}

/**
 * Brings this project's rows from other computers into the tree, oldest first so a
 * follow-up finds its parent; newer than the last pull only. Never throws.
 */
export async function pullNotes(p: SyncPorts, dataSource: string, change: (fn: (t: Tree) => Tree) => Promise<Tree>, tree: Tree): Promise<{ added: number } | { error: string }> {
  if (dataSource === '') return { added: 0 }
  try {
    const server = await serverOf(p)
    if (server === null) return { error: 'no connector' }
    const root = await p.projectKey()
    const { remote } = await p.place()
    const since = (await p.store.get(pullKey(root))) as number | undefined
    const filters: unknown[] = [
      { type: 'property', property: '專案', propertyType: 'select', operator: 'enum_is', value: { type: 'exact', value: projectName(remote, root) } },
    ]
    if (typeof since === 'number' && since > 0) {
      // a day's margin: a row written late by a slow computer is not missed (the Note ID check drops repeats)
      filters.push({ type: 'property', property: '建立時間', propertyType: 'date', operator: 'date_is_on_or_after', value: { type: 'exact', value: new Date(since - 86400000).toISOString() } })
    }
    const q = await p.mcp.call(server, 'notion-query-data-sources', {
      data: {
        mode: 'rows',
        data_source_url: dataSource,
        filter: { type: 'group', operator: 'and', filters },
        sort: [{ property: '建立時間', direction: 'ascending' }],
        limit: 100,
      },
    })
    if (q.isError) return { error: resultText(q).slice(0, 160) }
    const rows = parseRows(resultText(q))
    let added = 0
    let newest = typeof since === 'number' ? since : 0
    let t = tree
    for (const row of rows) {
      newest = Math.max(newest, row.at)
      if (t.nodes[row.noteId] || (await p.store.get(notionKey(root, row.noteId))) !== undefined) continue
      const page = await p.mcp.call(server, 'notion-fetch', { id: row.url })
      if (page.isError) continue
      const answer = pageContent(resultText(page))
      const answeredBy = (['claude-fork', 'claude', 'openai', 'manual'] as const).find(a => a === row.answeredBy) ?? 'claude'
      t = await change(cur => {
        if (cur.nodes[row.noteId]) return cur
        const made = addNode(
          cur,
          `notion:${row.machine}`,
          {
            id: row.noteId,
            question: row.question,
            anchor: { sessionId: `notion:${row.machine}`, turnId: null, messageId: null, at: row.at || Date.now(), mainSnippet: '' },
            route: { label: 'synced', confidence: 1, source: 'manual' },
            answeredBy,
            answer,
            title: row.title || undefined,
          },
          row.parentId ? { kind: 'under', parentId: row.parentId } : { kind: 'root' },
          { makeActive: false },
        ).tree
        return row.summary ? updateNode(made, row.noteId, { summary: row.summary }) : made
      })
      await p.store.set(notionKey(root, row.noteId), row.url)
      added++
    }
    if (newest > 0) await p.store.set(pullKey(root), newest)
    return { added }
  } catch (err) {
    return { error: String(err).slice(0, 160) }
  }
}
