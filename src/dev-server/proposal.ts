import { randomBytes } from 'node:crypto'
import { mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { AcpAgent } from '../acp-agent.js'
import { launchCommand } from '../agents.js'
import { ACP_NPM_PREFIX } from '../constants.js'
import type { Detection, ProjectFacts } from './detect.js'

export interface CommandProposal {
  readonly id: string
  readonly agent: string
  readonly line: string
  readonly cwd: string
  readonly reason: string
}

export type ProposalOutcome =
  | { kind: 'proposed'; proposal: CommandProposal }
  | { kind: 'none-found'; reason: string }
  | { kind: 'failed'; error: string }

export interface ProposalRequest {
  agent: string
  project: string
  facts: ProjectFacts
  undecided: Extract<Detection, { kind: 'undecided' }>
  signal: AbortSignal
}

export const PROPOSAL_TIMEOUT_MS = 180_000

const MAX_LINE = 500

export async function askAgentForCommand(req: ProposalRequest): Promise<ProposalOutcome> {
  try {
    return await askOnce(req)
  } catch (error) {
    return { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
  }
}

function askOnce(req: ProposalRequest): Promise<ProposalOutcome> {
  mkdirSync(ACP_NPM_PREFIX, { recursive: true })
  return new Promise((settle) => {
    let asked = false
    let done = false
    const finish = (outcome: ProposalOutcome) => {
      if (done) return
      done = true
      clearTimeout(timer)
      req.signal.removeEventListener('abort', aborted)
      agent.stop()
      settle(outcome)
    }
    const agent = new AcpAgent({
      command: req.agent,
      launch: launchCommand(req.agent, ACP_NPM_PREFIX),
      cwd: req.project,
      onChange: () => {
        const snap = agent.snapshot()
        if (snap.ask) agent.decline(snap.ask.id)
        if (snap.state === 'idle' && !asked) {
          asked = true
          agent.prompt(proposalPrompt(req))
        }
      },
      onTurnEnd: (reply) => finish(fromReply(reply, req)),
      onExit: (error) => finish({ kind: 'failed', error: error ?? 'the agent exited before it answered' }),
    })
    const timer = setTimeout(() => finish({ kind: 'failed', error: 'the agent did not answer in time' }), PROPOSAL_TIMEOUT_MS)
    const aborted = () => finish({ kind: 'failed', error: 'no longer needed' })
    req.signal.addEventListener('abort', aborted, { once: true })
  })
}

const REASONS: Record<ProposalRequest['undecided']['reason'], string> = {
  'no-package-json': 'There is no package.json at the project root.',
  'no-script': 'package.json has neither a "dev" nor a "start" script.',
  'monorepo-root': 'This is a workspace root with neither a "dev" nor a "start" script.',
}

export function proposalPrompt(req: Pick<ProposalRequest, 'project' | 'facts' | 'undecided'>): string {
  const scripts = Object.entries(req.facts.packageJson?.scripts ?? {})
  return [
    "ezdesign wants to start this project's local web dev server so the user can review the page.",
    `Please propose the command that starts this project's dev server, from ${req.project}.`,
    '',
    `Its own rules could not decide: ${REASONS[req.undecided.reason]}`,
    scripts.length ? `Scripts in package.json:\n${scripts.map(([name, line]) => `- ${name}: ${line}`).join('\n')}` : '',
    req.facts.lockfiles.length ? `Lockfiles: ${req.facts.lockfiles.join(', ')}` : 'No lockfile.',
    '',
    'Read files to decide; do not run anything or change anything - every such request will be declined.',
    'Choose the one web app a designer would want to see, and the command that serves it with live reload.',
    'End your answer with exactly one fenced json block:',
    '```json',
    '{"command": "pnpm --filter web dev", "cwd": ".", "reason": "one sentence"}',
    '```',
    '`cwd` is relative to the project root. If nothing here serves a web page, answer',
    '`{"command": null, "reason": "one sentence"}` instead.',
  ]
    .filter((line, i, all) => line || all[i - 1])
    .join('\n')
}

export type ParsedReply =
  | { kind: 'command'; line: string; cwd: string; reason: string }
  | { kind: 'none'; reason: string }

export function parseProposalReply(reply: string): ParsedReply | null {
  const blocks = [...reply.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)]
  const last = blocks.at(-1)?.[1]
  if (!last) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(last)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { command, cwd, reason } = parsed as Record<string, unknown>
  const why = typeof reason === 'string' ? reason.slice(0, MAX_LINE) : ''
  if (command === null) return { kind: 'none', reason: why }
  if (typeof command !== 'string') return null
  const line = command.trim()
  if (!line || line.length > MAX_LINE || /[\0\r\n]/.test(line)) return null
  const dir = typeof cwd === 'string' && cwd.trim() ? cwd.trim() : '.'
  if (isAbsolute(dir)) return null
  return { kind: 'command', line, cwd: dir, reason: why }
}

function fromReply(reply: string, req: ProposalRequest): ProposalOutcome {
  const parsed = parseProposalReply(reply)
  if (!parsed) return { kind: 'failed', error: 'the agent did not answer with a command' }
  if (parsed.kind === 'none') return { kind: 'none-found', reason: parsed.reason }
  const cwd = projectRelativePath(req.project, parsed.cwd)
  if (cwd === null) return { kind: 'failed', error: `the agent named a folder outside the project: ${parsed.cwd}` }
  return {
    kind: 'proposed',
    proposal: { id: randomBytes(8).toString('hex'), agent: req.agent, line: parsed.line, cwd, reason: parsed.reason },
  }
}

export function projectRelativePath(project: string, cwd: string): string | null {
  if (isAbsolute(cwd)) return null
  try {
    const root = realpathSync(project)
    const target = realpathSync(resolve(root, cwd))
    if (!statSync(target).isDirectory()) return null
    const rel = relative(root, target)
    return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && !isAbsolute(rel)) ? rel : null
  } catch {
    return null
  }
}
