// The MCP servers a chat passes when it creates an agent session. In ACP the host owns MCP
// configuration: an agent that reads its own files already has them, and an agent that does not
// (OMP ignores its on-disk servers in ACP mode by design) has no other way in. A spec that names
// no files passes none and keeps the old `mcpServers: []`.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  isMcpConfigInspectionNameWithinLimit,
  MCP_CONFIG_INSPECTION_MAX_SERVERS
} from '../../shared/mcp-config-inspection-limits'
import type { McpServer } from './generated/acp-protocol.generated'

/** One file an agent's own terminal lane reads. Every MCP document this bridges keeps its servers
 *  under `mcpServers`, the shape the other clients share. */
export type AcpMcpServerFile = {
  path: string
}

const McpDocumentSchema = z.looseObject({
  mcpServers: z.record(z.string(), z.unknown()).optional()
})

const McpServerEntrySchema = z.looseObject({
  type: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().optional()
})

/**
 * OMP's own files, in the order its terminal lane reads them: project, the profile this chat pinned,
 * then the portable files other MCP clients share. The first definition of a name wins; files are
 * not merged, which is also what `/mcp list` reports.
 *
 * The profile is read from the launch environment only: a chat that pinned no directory must not
 * inherit whatever profile happens to live under the home directory of whoever reads it.
 */
export function ompMcpServerFiles(input: {
  cwd: string
  env: Readonly<Record<string, string>>
}): AcpMcpServerFile[] {
  const agentDirectory = input.env.PI_CODING_AGENT_DIR?.trim()
  return [
    { path: join(input.cwd, '.omp', 'mcp.json') },
    ...(agentDirectory ? [{ path: join(agentDirectory, 'mcp.json') }] : []),
    { path: join(input.cwd, 'mcp.json') },
    { path: join(input.cwd, '.mcp.json') }
  ]
}

/** Every server the files define, first definition per name winning. Unreadable and malformed
 *  files are skipped: a chat start must not fail because one optional file is broken. */
export async function readAcpMcpServers(
  files: readonly AcpMcpServerFile[],
  env: Readonly<Record<string, string>> = {}
): Promise<McpServer[]> {
  const byName = new Map<string, McpServer>()
  for (const file of files) {
    if (byName.size >= MCP_CONFIG_INSPECTION_MAX_SERVERS) {
      break
    }
    const content = await readFile(file.path, 'utf8').catch(() => null)
    if (content === null) {
      continue
    }
    for (const server of parseAcpMcpServers(content, env)) {
      if (byName.size >= MCP_CONFIG_INSPECTION_MAX_SERVERS) {
        break
      }
      if (!byName.has(server.name)) {
        byName.set(server.name, server)
      }
    }
  }
  return [...byName.values()]
}

/** The ACP form of one MCP document. Entries the protocol cannot carry, or the agent marked
 *  disabled, are dropped rather than sent half-formed. */
export function parseAcpMcpServers(
  content: string,
  env: Readonly<Record<string, string>> = {}
): McpServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  const document = McpDocumentSchema.safeParse(parsed)
  if (!document.success) {
    return []
  }
  const servers = document.data.mcpServers
  if (!servers) {
    return []
  }
  const result: McpServer[] = []
  for (const [name, raw] of Object.entries(servers)) {
    if (result.length >= MCP_CONFIG_INSPECTION_MAX_SERVERS) {
      break
    }
    if (!isMcpConfigInspectionNameWithinLimit(name)) {
      continue
    }
    const entry = McpServerEntrySchema.safeParse(raw)
    if (!entry.success) {
      continue
    }
    const server = toAcpServer(name, entry.data, env)
    if (server) {
      result.push(server)
    }
  }
  return result
}

function toAcpServer(
  name: string,
  entry: z.infer<typeof McpServerEntrySchema>,
  env: Readonly<Record<string, string>>
): McpServer | null {
  if (entry.enabled === false) {
    return null
  }
  const type = entry.type ?? 'stdio'
  if (type === 'http' || type === 'sse') {
    const url = entry.url ? expandEnv(entry.url, env) : ''
    if (!url) {
      return null
    }
    return {
      type,
      name,
      url,
      headers: toNameValuePairs(entry.headers, env)
    }
  }
  if (type !== 'stdio') {
    return null
  }
  const command = entry.command ? expandEnv(entry.command, env) : ''
  if (!command) {
    return null
  }
  return {
    name,
    command,
    args: (entry.args ?? []).map((value) => expandEnv(value, env)),
    env: toNameValuePairs(entry.env, env)
  }
}

function toNameValuePairs(
  raw: Readonly<Record<string, string>> | undefined,
  env: Readonly<Record<string, string>>
): { name: string; value: string }[] {
  return Object.entries(raw ?? {}).map(([name, value]) => ({
    name,
    value: expandEnv(value, env)
  }))
}

/** `${VAR}` and `${VAR:-default}`, as the agents expand their own files. A name the environment
 *  does not carry expands to nothing rather than the literal placeholder. */
export function expandEnv(value: string, env: Readonly<Record<string, string>>): string {
  return value.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name, fallback) => {
      const fromEnv = env[name]
      if (fromEnv !== undefined) {
        return fromEnv
      }
      return typeof fallback === 'string' ? fallback : ''
    }
  )
}
