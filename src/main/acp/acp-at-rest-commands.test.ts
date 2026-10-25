import { access, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../shared/__fixtures__/omp-native-commands.json'
import { buildNativeChatPickerItems } from '../../shared/native-chat-picker-items'
import { sessionReportedSkills } from '../../shared/native-chat-slash-commands'
import { AT_REST_COMMANDS_TTL_MS } from '../native-chat/agent-session-wire/at-rest-command-catalog'
import { refreshAtRestCommandContext } from '../native-chat/agent-session-wire/at-rest-command-context'
import {
  commandDiscoveryRig,
  DISCOVERY_SESSION,
  ompRecord
} from './acp-command-discovery.test-fixture'
import { deferred, tick } from './acp-scripted-agent.test-support'
import { waitFor } from './acp-structured-adapter.test-support'

const rigs: Awaited<ReturnType<typeof commandDiscoveryRig>>[] = []
async function rig(...args: Parameters<typeof commandDiscoveryRig>) {
  const opened = await commandDiscoveryRig(...args)
  rigs.push(opened)
  return opened
}
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(rigs.splice(0).map((rig) => rig.dispose()))
  vi.restoreAllMocks()
})

it('observes pre-initialize reports, validates session identity and keeps the latest explicit empty', async () => {
  const { catalog, children } = await rig((child) => {
    child.agent.on('initialize', (frame) => {
      child.agent.notify('session/update', { sessionId: 'wrong', update: capture.enabled })
      child.agent.notify('session/update', {
        sessionId: DISCOVERY_SESSION,
        update: capture.enabled
      })
      child.agent.notify('session/update', {
        sessionId: DISCOVERY_SESSION,
        update: { sessionUpdate: 'available_commands_update', availableCommands: [] }
      })
      child.agent.reply(frame, { protocolVersion: 1, agentCapabilities: {} })
    })
    child.agent.on('session/new', (frame) =>
      child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
    )
  })
  expect(await catalog.settled(ompRecord(), 1_000)).toEqual([])
  await catalog.closeAll()
  expect(children[0]!.launch).toMatchObject({
    command: '/configured/omp',
    cwd: '/work/workspace-1',
    args: ['acp', '--plugin-dir', '/installed/plugin', '--session-dir', expect.any(String)],
    env: { PI_CODING_AGENT_DIR: '/accounts/omp', OMP_PROFILE: 'configured' },
    envToDelete: expect.arrayContaining([
      'ORCA_CHAT_SCRATCH_DIR',
      'ORCA_CHAT_VISUALS_DIR',
      'ORCA_PANE_KEY'
    ])
  })
  expect(children[0]!.agent.frames.map((frame) => frame.method)).toEqual([
    'initialize',
    'session/new'
  ])
  expect(children[0]!.agent.frames[1]!.params).toEqual({ cwd: '/work/workspace-1', mcpServers: [] })
  expect(children[0]!.lastCloseResult).toEqual({ root: 'exited', tree: null })
})

it.each([
  ['missing', capture.enabled],
  ['wrong', capture.disabled]
] as const)(
  'retains a real answer after a %s report and retries after 10 seconds',
  async (failure, initial) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { catalog, children } = await rig((child) => {
      child.agent.on('session/new', (frame) => {
        if (children.length === 1) {
          child.agent.notify('session/update', { sessionId: DISCOVERY_SESSION, update: initial })
        } else if (failure === 'wrong') {
          child.agent.notify('session/update', { sessionId: 'wrong', update: capture.enabled })
        }
        child.agent.reply(frame, { sessionId: DISCOVERY_SESSION })
      })
    })
    const record = ompRecord()
    const first = await catalog.settled(record, 1_000)
    expect(first?.map((row) => row.name)).toEqual(initial.availableCommands.map((row) => row.name))
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    await vi.advanceTimersByTimeAsync(AT_REST_COMMANDS_TTL_MS)
    const failed = catalog.settled(record, 10_000)
    await waitFor(() => expect(children).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await failed).toEqual(first)
    await vi.advanceTimersByTimeAsync(9_999)
    catalog.read(record)
    expect(children).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    catalog.read(record)
    await waitFor(() => expect(children).toHaveLength(3))
  }
)

it.each(['retire', 'deadline'] as const)(
  'prevents session/new after delayed initialize and %s',
  async (cancel) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const initialization = deferred<void>()
    const { catalog, children } = await rig((child) => {
      const initialize = child.initialize.bind(child)
      vi.spyOn(child, 'initialize').mockImplementation(async () => {
        await initialization.promise
        return initialize()
      })
    })
    if (cancel === 'deadline') {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    }
    catalog.read(ompRecord())
    await waitFor(() => expect(children).toHaveLength(1))
    if (cancel === 'retire') {
      catalog.retireContext()
    } else {
      await vi.advanceTimersByTimeAsync(9_000)
    }
    await catalog.closeAll()
    initialization.resolve()
    await tick()
    expect(children[0]!.agent.frames.some((frame) => frame.method === 'session/new')).toBe(false)
    expect(children[0]!.closes).toBe(1)
  }
)

it('starts the 9 second deadline before readiness and cwd resolution', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const readiness = deferred<void>()
  const refreshing = refreshAtRestCommandContext(() => readiness.promise)
  const cwd = deferred<string>()
  const resolveWorkspacePath = vi.fn(() => cwd.promise)
  const { catalog, children } = await rig(undefined, { resolveWorkspacePath })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const first = catalog.settled(ompRecord('waiting-ready'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await first).toBeUndefined()
  readiness.resolve()
  await refreshing
  expect(resolveWorkspacePath).not.toHaveBeenCalled()
  const second = catalog.settled(ompRecord('waiting-cwd'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await second).toBeUndefined()
  cwd.resolve('/work/late')
  await tick()
  expect(children).toEqual([])
})

it('settles availability at the deadline but retains admission and shutdown ownership through a late version reader', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const version = deferred<{ version: string }>()
  const probeVersion = vi.fn(() => version.promise)
  const { catalog, children } = await rig(undefined, { probeVersion })
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const reads = ['one', 'two', 'three'].map((id) => catalog.settled(ompRecord(id), 10_000))
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await Promise.all(reads)).toEqual([undefined, undefined, undefined])
  expect(probeVersion).toHaveBeenCalledTimes(2)
  let drained = false
  const stop = catalog.closeAll().then(() => {
    drained = true
  })
  await tick()
  expect(drained).toBe(false)
  version.resolve({ version: '18.12.6' })
  await stop
  expect(children).toEqual([])
})

it.each([10, 100, 257])(
  'bounds the actual read trigger at %i contexts without evicting answers or spawning on queries',
  async (count) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const close = deferred<void>()
    const { catalog, children, root } = await rig((child) => {
      const prove = child.proveClose
      child.proveClose = async () => {
        await close.promise
        return prove()
      }
    })
    const records = Array.from({ length: count }, (_, index) => ompRecord(`context-${index}`))
    let subscribers = records
    let publications = 0
    catalog.onChange(() => {
      publications++
      subscribers.forEach((record) => catalog.read(record))
    })
    records.forEach((record) => {
      catalog.read(record)
      catalog.read(record)
    })
    await waitFor(() => expect(children.filter((child) => child.closes === 1)).toHaveLength(2))
    expect(publications).toBe(2)
    expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toHaveLength(2)
    const rows = catalog.read(records[0]!)!
    for (let index = 0; index < count; index++) {
      buildNativeChatPickerItems([], [], `plan${index}`, '/', sessionReportedSkills(rows, 'omp'))
    }
    expect(children).toHaveLength(2)
    subscribers = records.filter((_, index) => index < 2 || index >= 5)
    records.slice(2, 5).forEach((record) => catalog.retireContext(record.location.workspaceId))
    await tick()
    expect(catalog.read(records[0]!)).toEqual(rows)
    close.resolve()
    await waitFor(() => expect(children).toHaveLength(Math.min(count, 34) - 3))
    await catalog.closeAll()
    expect(publications).toBeLessThanOrEqual(Math.min(count, 34))
    expect(
      children.some((child) =>
        ['/work/context-2', '/work/context-3', '/work/context-4'].includes(child.launch.cwd!)
      )
    ).toBe(false)
    expect(children.every((child) => child.closes === 1 && child.exited)).toBe(true)
    expect(await readdir(join(root, 'acp-command-sessions', 'omp'))).toEqual([])
  }
)

it('answers before slow close, cancels queued deadlines and drains stop without launching waiters', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const close = deferred<void>()
  const { catalog, children } = await rig((child) => {
    const prove = child.proveClose
    child.proveClose = async () => {
      await close.promise
      return prove()
    }
  })
  expect(await catalog.settled(ompRecord('one'), 1_000)).toBeDefined()
  expect(await catalog.settled(ompRecord('two'), 1_000)).toBeDefined()
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const queued = catalog.settled(ompRecord('queued'), 10_000)
  await vi.advanceTimersByTimeAsync(9_000)
  expect(await queued).toBeUndefined()
  const stop = catalog.closeAll()
  close.resolve()
  await stop
  expect(children).toHaveLength(2)
})

it('retains failed close evidence, storage and permits until observed exit instead of recycling owners', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const { catalog, children } = await rig((child) => {
    child.proveClose = async () => {
      child.evidence = { root: 'live', tree: 'unverifiable' }
      return false
    }
  })
  await catalog.settled(ompRecord('one'), 1_000)
  await catalog.settled(ompRecord('two'), 1_000)
  catalog.read(ompRecord('three'))
  await expect(catalog.closeAll()).rejects.toThrow(/could not prove/)
  expect(children).toHaveLength(2)
  for (const child of children) {
    const folder = child.launch.args.at(-1)!
    await access(folder)
    expect(child.lastCloseResult).toEqual({ root: 'live', tree: 'unverifiable' })
    child.evidence = { root: 'exited', tree: 'exited' }
    child.exit()
  }
  await catalog.closeAll()
})
