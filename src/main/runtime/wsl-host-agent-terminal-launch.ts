import { isWslHostOrcadProcess } from '../ipc/wsl-guest-windows-drive-path'
import { resolveGuestNativeAgentCommand } from '../codex-cli/command'
import {
  isWindowsOnlyAgentCommand,
  windowsOnlyCliMessage
} from '../codex-cli/windows-only-agent-cli'
import type { AgentStartupPlanInputs } from '../../shared/agent-startup-plan-inputs'
import {
  getTuiAgentDetectCommands,
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from '../../shared/tui-agent-config'
import { getOrcaCliCommandNameForPlatform } from '../../shared/orca-cli-command-name'
import { hasExplicitTuiLaunchCommand } from '../../shared/tui-agent-launch-command-override'
import { quoteStartupArg, resolveStartupShell } from '../../shared/tui-agent-startup-shell'

export type WslHostAgentProbe = {
  isWslHost?: boolean
  mounts?: readonly string[]
  homePath?: string
}

/**
 * On a WSL-host orcad, launch the stock agent by its distro path, or refuse when only a Windows copy
 * exists, as chat does; a bare name would reach the Windows shim through PATH interop. The PTY env is
 * untouched. Unchanged off a WSL host, for remote launches, and under an explicit Command setting.
 */
export function resolveWslHostAgentLaunchInputs(
  inputs: AgentStartupPlanInputs,
  pathEnv: string | undefined,
  probe: WslHostAgentProbe = {}
): AgentStartupPlanInputs {
  const { agent, platform } = inputs
  if (
    !(probe.isWslHost ?? isWslHostOrcadProcess()) ||
    inputs.isRemote ||
    hasExplicitTuiLaunchCommand({ agentCmdOverrides: inputs.cmdOverrides }, agent)
  ) {
    return inputs
  }
  const config = TUI_AGENT_CONFIG[agent]
  const [program, ...rest] = getTuiAgentLaunchCommand(config, platform).split(' ')
  const options = { pathEnv, platform, ...(probe.homePath ? { homePath: probe.homePath } : {}) }
  // A CLI the agent runs under its own command (Agent Teams' claude, dsh's dsh) can't be Windows-only either.
  for (const name of config.detectRequiredCommands ?? []) {
    const message = windowsOnlyCliMessage(
      resolveGuestNativeAgentCommand(name, options, probe.mounts),
      name
    )
    if (message) {
      throw new Error(message)
    }
  }
  // Wrapper launches (Agent Teams runs Orca's CLI as `orca` or `orca-ide`) keep their command.
  if (
    program !== config.detectCmd ||
    getTuiAgentDetectCommands(config).includes(getOrcaCliCommandNameForPlatform(platform))
  ) {
    return inputs
  }
  let windowsOnly: string | null = null
  let resolved: string | null = null
  // A native alias (qoder for qodercli) beats a Windows-only primary name.
  for (const name of getTuiAgentDetectCommands(config)) {
    const candidate = resolveGuestNativeAgentCommand(name, options, probe.mounts)
    if (isWindowsOnlyAgentCommand(candidate)) {
      windowsOnly ??= candidate
    } else if (candidate !== name) {
      resolved = candidate
      break
    }
  }
  if (!resolved) {
    if (windowsOnly) {
      throw new Error(
        `${windowsOnlyCliMessage(windowsOnly, agent)} Or set the ${agent} Command setting to a program inside the distro.`
      )
    }
    return inputs
  }
  const head = quoteStartupArg(resolved, resolveStartupShell(platform, inputs.shell))
  return { ...inputs, cmdOverrides: { ...inputs.cmdOverrides, [agent]: [head, ...rest].join(' ') } }
}
