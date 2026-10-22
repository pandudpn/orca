import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  expandEnv,
  ompMcpServerFiles,
  parseAcpMcpServers,
  readAcpMcpServers
} from './acp-mcp-servers'

async function writeDocument(path: string, servers: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, JSON.stringify({ mcpServers: servers }), 'utf8')
}

describe('reading an agent own MCP document as ACP servers', () => {
  it('maps a stdio server, expanding the environment in args and env values', () => {
    const servers = parseAcpMcpServers(
      JSON.stringify({
        mcpServers: {
          hub: {
            command: 'uv',
            args: ['run', '--directory', '${HUB_DIR}'],
            env: { MCP_HUB_CONFIG: '${HUB_DIR}/servers.yaml', EMPTY: '${MISSING:-fallback}' }
          }
        }
      }),
      { HUB_DIR: '/srv/hub' }
    )
    expect(servers).toEqual([
      {
        name: 'hub',
        command: 'uv',
        args: ['run', '--directory', '/srv/hub'],
        env: [
          { name: 'MCP_HUB_CONFIG', value: '/srv/hub/servers.yaml' },
          { name: 'EMPTY', value: 'fallback' }
        ]
      }
    ])
  })

  it('maps http and sse servers, and drops entries the protocol cannot carry', () => {
    const servers = parseAcpMcpServers(
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://example.test/mcp',
            headers: { Authorization: 'Bearer ${TOKEN}' }
          },
          legacy: { type: 'sse', url: 'https://example.test/sse' },
          disabled: { command: 'nope', enabled: false },
          missingCommand: { args: ['x'] },
          missingUrl: { type: 'http' },
          otherTransport: { type: 'websocket', command: 'x' }
        }
      }),
      { TOKEN: 'secret' }
    )
    expect(servers).toEqual([
      {
        type: 'http',
        name: 'remote',
        url: 'https://example.test/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer secret' }]
      },
      { type: 'sse', name: 'legacy', url: 'https://example.test/sse', headers: [] }
    ])
  })

  it('treats a document it cannot parse as no servers rather than throwing', () => {
    expect(parseAcpMcpServers('{ not json')).toEqual([])
    expect(parseAcpMcpServers('{"servers": {}}')).toEqual([])
    expect(parseAcpMcpServers('{"mcpServers": []}')).toEqual([])
  })

  it('leaves an unknown placeholder empty instead of the literal text', () => {
    expect(expandEnv('${MISSING}', {})).toBe('')
    expect(expandEnv('${A}-${B:-b}', { A: 'a' })).toBe('a-b')
  })
})

describe('which files a chat reads, and in what order', () => {
  it('reads OMP project, its profile, then the portable files its terminal lane shares', () => {
    expect(
      ompMcpServerFiles({ cwd: '/work/project', env: { PI_CODING_AGENT_DIR: '/work/profile' } })
    ).toEqual([
      { path: join('/work/project', '.omp', 'mcp.json') },
      { path: join('/work/profile', 'mcp.json') },
      { path: join('/work/project', 'mcp.json') },
      { path: join('/work/project', '.mcp.json') }
    ])
  })

  it('keeps the first definition of a name and skips files that are missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const project = join(root, 'project')
    const profile = join(root, 'profile')
    await writeDocument(join(project, '.omp', 'mcp.json'), {
      shared: { command: 'project-copy' },
      projectOnly: { command: 'project-server' }
    })
    await writeDocument(join(profile, 'mcp.json'), {
      shared: { command: 'profile-copy' },
      profileOnly: { command: 'profile-server' }
    })

    const servers = await readAcpMcpServers(
      ompMcpServerFiles({ cwd: project, env: { PI_CODING_AGENT_DIR: profile } })
    )

    expect(servers.map((server) => [server.name, 'command' in server && server.command])).toEqual([
      ['shared', 'project-copy'],
      ['projectOnly', 'project-server'],
      ['profileOnly', 'profile-server']
    ])
  })

  it('returns nothing when no file exists, and never fails a start over a bad file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'acp-mcp-servers-'))
    const files = ompMcpServerFiles({ cwd: root, env: {} })
    expect(await readAcpMcpServers(files)).toEqual([])

    await mkdir(join(root, '.omp'), { recursive: true })
    await writeFile(join(root, '.omp', 'mcp.json'), 'not json', 'utf8')
    expect(await readAcpMcpServers(files)).toEqual([])
  })
})
