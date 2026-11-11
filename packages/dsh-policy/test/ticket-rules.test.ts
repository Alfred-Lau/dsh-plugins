import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkTicketDeny,
  compileBlockedCommand,
  compileTicketRules,
  globToRegExp,
  ruleForTicket,
} from '../lib/ticket-rules.js'

/** Walks an args object and returns every string, the way the matcher does. */
function strings(args: unknown): string[] {
  const out: string[] = []
  const walk = (value: unknown): void => {
    if (typeof value === 'string') out.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object') Object.values(value).forEach(walk)
  }
  walk(args)
  return out
}

const deny = compileTicketRules([{ match: 'fix-*', blockedCommands: ['git', 'gh'] }])

test('a blocked command is denied at a command position', () => {
  assert.ok(compileBlockedCommand('git').test('git push origin main'))
  assert.ok(compileBlockedCommand('git').test('cd repo && git push'))
  assert.ok(compileBlockedCommand('git').test('ls; git status'))
  assert.ok(compileBlockedCommand('git').test('git'))
})

test('the absolute-path bypass Super-agent documents is closed', () => {
  const re = compileBlockedCommand('git')
  assert.ok(re.test('/usr/bin/git push'))
  assert.ok(re.test('/usr/local/bin/git push'))
  assert.ok(re.test('./node_modules/.bin/git status'))
  assert.ok(re.test('../bin/git status'))
  assert.ok(re.test('env git push'))
  assert.ok(re.test('GIT_AUTHOR=x git commit'))
})

test('a longer command name is not truncated into a match', () => {
  const re = compileBlockedCommand('git')
  assert.ok(!re.test('gitlab-cli run'))
  assert.ok(!re.test('github-cli run'))
  // A path segment ending in the name is fine to match; a longer basename is not.
  assert.ok(!re.test('cat .git/config'))
})

test('shell metacharacters in the command name are escaped', () => {
  const re = compileBlockedCommand('rm.sh')
  assert.ok(re.test('rm.sh -rf /'))
  assert.ok(!re.test('rmXsh -rf /'))
})

test('globToRegExp anchors and escapes', () => {
  assert.ok(globToRegExp('fix-*').test('fix-login'))
  assert.ok(!globToRegExp('fix-*').test('review-login'))
  assert.ok(globToRegExp('*').test('anything'))
  assert.ok(globToRegExp('t-??').test('t-42'))
  assert.ok(!globToRegExp('t-??').test('t-421'))
})

test('ruleForTicket picks the first matching glob and labels the router', () => {
  const rules = compileTicketRules([
    { match: 'fix-*', blockedCommands: ['git'] },
    { match: '*', blockedCommands: ['rm'] },
  ])
  assert.equal(ruleForTicket({ role: 'worker', ticketId: 'fix-login' }, rules)?.match, 'fix-*')
  assert.equal(ruleForTicket({ role: 'worker', ticketId: 'review-pr' }, rules)?.match, '*')
  assert.equal(ruleForTicket({ role: 'router' }, rules)?.match, '*')
  assert.equal(ruleForTicket(undefined, rules), undefined)
})

test('a blocked command in the tool args denies the call', () => {
  const verdict = checkTicketDeny(
    { tool: 'bash', args: { command: 'cd /tmp && /usr/bin/git push --force' } },
    { role: 'worker', ticketId: 'fix-login' },
    deny,
    strings,
  )
  assert.equal(verdict?.decision, 'deny')
  assert.match(verdict!.reason, /fix-login/)
  assert.equal(verdict!.ruleId, 'ticket:fix-*:cmd:git')
})

test('an allowed command passes the ticket gate', () => {
  assert.equal(
    checkTicketDeny({ tool: 'bash', args: { command: 'npm test' } }, { role: 'worker', ticketId: 'fix-login' }, deny, strings),
    undefined,
  )
})

test('a ticket with no matching rule is not gated', () => {
  const scoped = compileTicketRules([{ match: 'fix-*', blockedCommands: ['git'] }])
  assert.equal(
    checkTicketDeny({ tool: 'bash', args: { command: 'git push' } }, { role: 'worker', ticketId: 'review-pr' }, scoped, strings),
    undefined,
  )
})

test('a tool allow-list denies everything outside it', () => {
  const rules = compileTicketRules([{ match: 'review-*', blockedCommands: [], allowedTools: ['read', 'grep'] }])
  assert.equal(
    checkTicketDeny({ tool: 'bash', args: { command: 'ls' } }, { role: 'worker', ticketId: 'review-pr' }, rules, strings)?.ruleId,
    'ticket:review-*:tools',
  )
  assert.equal(
    checkTicketDeny({ tool: 'read', args: { path: '/tmp/a' } }, { role: 'worker', ticketId: 'review-pr' }, rules, strings),
    undefined,
  )
})

test('the deny reason names the command and quotes what matched', () => {
  const verdict = checkTicketDeny(
    { tool: 'bash', args: { command: 'gh pr create' } },
    { role: 'worker', ticketId: 'fix-login' },
    deny,
    strings,
  )
  assert.match(verdict!.reason, /"gh"/)
  assert.match(verdict!.reason, /gh pr create/)
})

test('an empty blocked list with no allow-list never denies', () => {
  const rules = compileTicketRules([{ match: 'fix-*', blockedCommands: [] }])
  assert.equal(
    checkTicketDeny({ tool: 'bash', args: { command: 'rm -rf /' } }, { role: 'worker', ticketId: 'fix-login' }, rules, strings),
    undefined,
  )
})
