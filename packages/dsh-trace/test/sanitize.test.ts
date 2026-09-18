import test from 'node:test'
import assert from 'node:assert/strict'
import { createSanitizer } from '../lib/sanitize.js'
import type { SanitizeConfig } from '../lib/types.js'

const base: SanitizeConfig = {
  enabled: true,
  truncatePromptChars: 20,
  truncateCompletionChars: 20,
  truncateToolInputChars: 20,
  truncateToolOutputChars: 20,
  truncateAttributeChars: 50,
}

test('redacts sensitive keys recursively', () => {
  const s = createSanitizer({ ...base })
  const out = s.value({
    apiKey: 'sk-very-secret',
    nested: { password: 'hunter2', keep: 'visible' },
    list: [{ token: 'tok-1' }],
  }) as Record<string, unknown>
  assert.equal(out.apiKey, '[REDACTED]')
  const nested = out.nested as Record<string, unknown>
  assert.equal(nested.password, '[REDACTED]')
  assert.equal(nested.keep, 'visible')
  const list = out.list as Array<Record<string, unknown>>
  assert.equal(list[0]?.token, '[REDACTED]')
})

test('redacts builtin secret patterns inside strings', () => {
  const s = createSanitizer({ ...base })
  const out = s.text('call with sk-abcdef1234567890abcdef and Bearer abc.def.ghi') as string
  assert.ok(!out.includes('sk-abcdef1234567890abcdef'), 'sk- key should be redacted')
  assert.ok(!out.includes('Bearer abc.def.ghi'), 'bearer token should be redacted')
})

test('honors custom redact patterns', () => {
  const s = createSanitizer({ ...base, redactPatterns: ['PROJECT-[A-Z0-9]+'] })
  const out = s.text('id=PROJECT-9XQ7 done') as string
  assert.ok(!out.includes('PROJECT-9XQ7'))
})

test('truncates with budget and marker', () => {
  const s = createSanitizer({ ...base })
  const long = 'x'.repeat(100)
  const out = s.text(long, 20) as string
  assert.ok(out.length < 50)
  assert.ok(out.includes('[truncated'), 'should carry a truncation marker')
})

test('disabled sanitizer passes values through', () => {
  const s = createSanitizer({ ...base, enabled: false })
  const v = { apiKey: 'sk-keep-me', other: 'plain' }
  assert.deepEqual(s.value(v), v)
})
