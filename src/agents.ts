/** The agents a review can be driven by.
 *
 *  A profile is a short name for the command line that starts that agent's ACP
 *  server. Shared by the CLI's `--agent` flag and the shell's picker so the two
 *  cannot drift into offering different things under the same name. */

import { shellQuote } from './shell-quote.js'

/** Whose models an agent runs, for the mark shown beside one. An agent is not a
 *  brand - Claude Code is not Anthropic - but the model it is about to answer
 *  with belongs to one, and a model named only "6 Astra" does not say whose. */
export type AgentBrand = 'claude' | 'openai'

export interface AgentProfile {
  id: string
  /** What the shell shows. */
  name: string
  /** Shell command that starts the agent's ACP server on stdio. */
  command: string
  /** The CLI this profile ultimately drives, for the "is it installed" check.
   *  Not the same as `command`: two of these start through `npx`, which fetches
   *  the adapter but cannot conjure the agent behind it. */
  binary: string
  /** The npm package `command` runs through npx, when it does. */
  adapter?: string
  brand?: AgentBrand
}

const CLAUDE_ADAPTER = '@agentclientprotocol/claude-agent-acp'
const CODEX_ADAPTER = '@agentclientprotocol/codex-acp'

export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: `npx -y ${CLAUDE_ADAPTER}`,
    binary: 'claude',
    adapter: CLAUDE_ADAPTER,
    brand: 'claude',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: `npx -y ${CODEX_ADAPTER}`,
    binary: 'codex',
    adapter: CODEX_ADAPTER,
    brand: 'openai',
  },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini --experimental-acp', binary: 'gemini' },
]

/** A profile's command, or the argument itself when it names no profile - which
 *  is how a custom ACP server is started. */
export function agentCommand(agent: string): string {
  return AGENT_PROFILES.find((p) => p.id === agent)?.command ?? agent
}

/** The profile a running command came from, if any. Matched on the command
 *  rather than remembered as an id, because the command is what is persisted
 *  with the session and what a chat is keyed by. */
export function agentProfileFor(command: string): AgentProfile | undefined {
  return AGENT_PROFILES.find((p) => p.command === command)
}

/** The command line that starts `command`. A profile's adapter is resolved from
 *  `npmPrefix` rather than the project, where npx prefers any copy in the
 *  project's dependency tree: one pnpm links no bin for, or one at whatever
 *  version the project happened to pull in. */
export function launchCommand(command: string, npmPrefix: string): string {
  const adapter = agentProfileFor(command)?.adapter
  return adapter ? `npx -y --prefix ${shellQuote(npmPrefix)} ${adapter}` : command
}

/** Whose models the running agent answers with, when it is one we know. */
export function agentBrandFor(command: string): AgentBrand | undefined {
  return agentProfileFor(command)?.brand
}
