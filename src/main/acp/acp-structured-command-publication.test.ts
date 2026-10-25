import { afterEach, expect, it, vi } from 'vitest'
import capture from '../../shared/__fixtures__/omp-native-commands.json'
import type { AgentSessionSubscribeEvent } from '../../shared/agent-session-wire'
import { openHostRig } from './acp-structured-host.test-support'
import { acpLaunchSpecFor } from './acp-launch-specs'
import { FakeAcpChild, PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { CALLER } from '../native-chat/agent-session-wire/structured-agent-session-host-test-harness'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestAttachParams
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

it.each([
  ['omp', 10],
  ['omp', 100],
  ['grok', 10]
] as const)(
  'publishes %s command-only reports without visiting %i unrelated sessions',
  async (agent, count) => {
    const spec = acpLaunchSpecFor(agent)!
    const subscribe = vi.spyOn(FakeAcpChild.prototype, 'subscribe')
    const { rig, host, ready } = await openHostRig({
      spec,
      script: (agent) => {
        agent.on('session/new', (frame) => {
          agent.notify('session/update', { sessionId: PROVIDER_SESSION, update: capture.disabled })
          agent.reply(frame, { sessionId: PROVIDER_SESSION })
        })
      }
    })
    expect(
      await host.attach(
        CALLER,
        hostTestAttachParams(null, {
          provider: agent,
          agent,
          providerHandle: undefined,
          accountHome: {
            variable: agent === 'omp' ? 'PI_CODING_AGENT_DIR' : 'GROK_HOME',
            path: '/fake/account'
          }
        })
      )
    ).toMatchObject({ ok: true })
    await ready()
    const lateReport = subscribe.mock.calls[0]![0]
    subscribe.mockRestore()
    await rig.settle()
    await host.flushStreamedEvents(SESSION)
    const events: AgentSessionSubscribeEvent[] = []
    const unsubscribe = await host.subscribe({
      id: 'desktop',
      sessionId: SESSION,
      emit: (event) => events.push(event)
    })
    expect(events[0]).toMatchObject({ commands: [{ name: 'compact', kind: 'command' }] })
    const { subscribers, sessions } = host.collaboratorsForTests()
    const journal = sessions.get(SESSION)!.journal
    const unrelated = vi.fn()
    const stops = Array.from({ length: count }, (_, index) =>
      subscribers.open({
        id: `desktop-${index}`,
        sessionId: `unrelated-${index}`,
        journal,
        fence: 1,
        emit: unrelated
      })
    )
    const reads = vi.spyOn(rig.adapter, 'readCommands')
    try {
      for (const report of [
        capture.enabled,
        capture.disabled,
        { sessionUpdate: 'available_commands_update', availableCommands: [] }
      ]) {
        events.length = 0
        unrelated.mockClear()
        reads.mockClear()
        rig.child().agent.notify('session/update', { sessionId: PROVIDER_SESSION, update: report })
        await rig.settle()
        await host.flushStreamedEvents(SESSION)
        await waitFor(() => expect(events).toHaveLength(1))
        const frame = events.find((event) => 'commands' in event)!
        expect(frame.commands?.map(({ name, kind }) => [name, kind])).toEqual(
          report.availableCommands.map(({ name }) => [name, 'command'])
        )
        expect(await host.readCommands(SESSION)).toEqual({ commands: frame.commands })
        expect(unrelated).not.toHaveBeenCalled()
        expect(new Set(reads.mock.calls.map(([id]) => id))).toEqual(new Set([SESSION]))
        expect(reads.mock.calls.length).toBeLessThanOrEqual(8)
      }
      await host.close(SESSION, 'user-close')
      events.length = 0
      reads.mockClear()
      lateReport({
        kind: 'known',
        notification: {
          sessionId: PROVIDER_SESSION,
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] }
        }
      })
      await rig.settle()
      expect(events).toEqual([])
      expect(reads).not.toHaveBeenCalled()
    } finally {
      reads.mockRestore()
      stops.forEach((stop) => stop())
      unsubscribe()
      await host.close(SESSION, 'user-close')
    }
  }
)
