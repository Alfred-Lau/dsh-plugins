import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { POLICY_VERSION } from '../lib/types.js'

/**
 * The audit log carries `policy_version` on every line so an operator can tell
 * which build produced a decision. A stale constant is worse than no constant:
 * it actively misdirects whoever is debugging a rule that "does not fire".
 */

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name: string; version: string }

test('POLICY_VERSION tracks package.json', () => {
  assert.equal(POLICY_VERSION, `${pkg.name}@${pkg.version}`)
})
