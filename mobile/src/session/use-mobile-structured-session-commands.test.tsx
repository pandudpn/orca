import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcClient } from '../transport/rpc-client'
import { useMobileStructuredSessionCommands } from './use-mobile-structured-session-commands'
import {
  commandDiscoveryRig,
  ompRecord
} from '../../../src/main/acp/acp-command-discovery.test-fixture'
import { mobileComposerSlashItems } from './mobile-native-chat-composer-menu'
import { applyAutocomplete, detectAutocompleteTrigger } from './mobile-native-chat-autocomplete'
import { deferred } from '../../../src/main/acp/acp-scripted-agent.test-support'

type Hook = ReturnType<typeof useMobileStructuredSessionCommands>

describe('useMobileStructuredSessionCommands', () => {
  let renderer: ReactTestRenderer | null = null
  let hook: Hook | null = null
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
  })

  function Probe(props: { client: RpcClient; sessionId: string }) {
    hook = useMobileStructuredSessionCommands({ ...props, hostId: 'host-1', enabled: true })
    return null
  }

  it('receives real native rows on its first one-shot read and selects before any send, independently of slow teardown', async () => {
    const close = deferred<void>()
    const discovery = await commandDiscoveryRig((child) => {
      const prove = child.proveClose
      child.proveClose = async () => {
        await close.promise
        return prove()
      }
    })
    const sendRequest = vi.fn(async () => ({
      id: 'first-open',
      ok: true as const,
      result: { commands: await discovery.catalog.settled(ompRecord(), 10_000) },
      _meta: { runtimeId: 'host-runtime' }
    }))
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    try {
      await act(async () => {
        renderer = create(createElement(Probe, { client, sessionId: 'fresh-omp' }))
      })
      await act(async () => {
        await vi.waitFor(() => expect(sendRequest).toHaveBeenCalledOnce())
        await sendRequest.mock.results[0]!.value
      })
      const selected = mobileComposerSlashItems({
        agent: 'omp',
        structured: { reported: hook!.commands, conversationCommands: [] },
        query: 'skill:pl'
      }).find((row) => row.kind === 'skill')!
      expect(selected.token).toBe('/skill:plan')
      expect(discovery.children[0]!.exited).toBe(false)
      const draft = '/skill:pl'
      const completed = applyAutocomplete(
        draft,
        detectAutocompleteTrigger(draft, draft.length)!,
        selected.token
      )
      expect(`${completed.text}focus`).toBe('/skill:plan focus')
      expect(sendRequest).toHaveBeenCalledExactlyOnceWith('agentSession.commands', {
        sessionId: 'fresh-omp'
      })
      expect(discovery.children[0]!.agent.frames.map((frame) => frame.method)).toEqual([
        'initialize',
        'session/new'
      ])
    } finally {
      close.resolve()
      await discovery.dispose()
    }
  })

  it('reads the session’s list, again when the menu opens, and never shows another session’s', async () => {
    const lists: Record<string, { name: string; kind: 'skill' | 'command' }[]> = {
      a: [{ name: 'review-pr', kind: 'skill' }],
      b: [{ name: 'compact', kind: 'command' }]
    }
    const answers: { sessionId: string; answer: () => void }[] = []
    let holdNext = false
    const sendRequest = vi.fn(async (_method: string, params: unknown) => {
      const sessionId =
        typeof params === 'object' && params !== null && 'sessionId' in params
          ? String(params.sessionId)
          : ''
      if (holdNext) {
        holdNext = false
        await new Promise<void>((resolve) => answers.push({ sessionId, answer: resolve }))
      }
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: lists[sessionId] },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    expect(sendRequest).toHaveBeenCalledWith('agentSession.commands', { sessionId: 'a' })
    expect(hook!.commands).toEqual(lists.a)

    lists.a = [...lists.a!, { name: 'research', kind: 'skill' }]
    await act(async () => hook!.refresh())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])

    holdNext = true
    await act(async () => renderer!.update(createElement(Probe, { client, sessionId: 'b' })))
    expect(hook!.commands).toBeUndefined()
    await act(async () => answers.shift()!.answer())
    expect(hook!.commands).toEqual(lists.b)
  })

  it('reads again after the current read when the menu opens during it', async () => {
    let catalog = [{ name: 'review-pr', kind: 'skill' as const }]
    const answers: (() => void)[] = []
    const sendRequest = vi.fn(async () => {
      const answered = [...catalog]
      await new Promise<void>((resolve) => answers.push(resolve))
      return {
        id: 'rpc-1',
        ok: true as const,
        result: { commands: answered },
        _meta: { runtimeId: 'runtime-1' }
      }
    })
    const client: RpcClient = {
      sendRequest,
      subscribe: () => () => {},
      updateTerminalSubscriptionViewport: () => {},
      getState: () => 'connected',
      getReconnectAttempt: () => 0,
      getLastConnectedAt: () => null,
      onStateChange: () => () => {},
      notifyForeground: () => {},
      close: () => {}
    }
    await act(async () => {
      renderer = create(createElement(Probe, { client, sessionId: 'a' }))
    })
    catalog = [...catalog, { name: 'research', kind: 'skill' as const }]
    await act(async () => hook!.refresh())
    expect(sendRequest).toHaveBeenCalledTimes(1)

    await act(async () => answers.shift()!())
    expect(sendRequest).toHaveBeenCalledTimes(2)
    await act(async () => answers.shift()!())
    expect(hook!.commands?.map((entry) => entry.name)).toEqual(['review-pr', 'research'])
  })
})
