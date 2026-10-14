// Notion sync (REQUESTS.md R5 / remote, 10/14): the notes of every computer in one Notion
// database, reached through the claude.ai Notion connector ($.mcp.call), so no token sits
// in the mod. This first part only finds the connector and checks the database; the sync
// itself comes after the probe says the calls work from a mod.
import type { Ports } from './ports'

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
