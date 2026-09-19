import test from 'node:test'
import assert from 'node:assert/strict'
import { compileDetectors, PiiDetector, collectStrings, countByType } from '../lib/detector.js'

function det(overrides: Record<string, boolean> = {}, customs: { name: string; pattern: string }[] = []) {
  const compiled = compileDetectors({ detectors: overrides, customPatterns: customs })
  return new PiiDetector(compiled)
}

const DEFAULT_ALL_ON = {
  email: true, phone_cn: true, phone_intl: true, cn_id: true,
  credit_card: true, api_key: true, ssn: true, ipv4: false, iban: false,
}

test('email detected; evidence is a hash, not raw text', () => {
  const d = det(DEFAULT_ALL_ON)
  const matches = d.scan('contact alice@example.com or bob@test.io')
  const emails = matches.filter((m) => m.type === 'email')
  assert.equal(emails.length, 1) // one hit per detector per string
  assert.equal(emails[0].detector, 'email')
  assert.match(emails[0].evidence, /^[0-9a-f]{8}$/)
})

test('CN phone with separators is not missed; embedded runs ignored', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(d.scan('call 13912345678 now').some((m) => m.type === 'phone_cn'))
  assert.ok(!d.scan('order 1139123456780 tracked').some((m) => m.type === 'phone_cn'))
})

test('intl phone E.164', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(d.scan('fax +86-13912345678').some((m) => m.type === 'phone_intl'))
})

test('cn_id requires valid checksum', () => {
  const d = det(DEFAULT_ALL_ON)
  // 11010519491231002X is the canonical GB11643 example, checksum valid.
  assert.ok(d.scan('id 11010519491231002X').some((m) => m.type === 'cn_id'))
  // Off-by-one in checksum must NOT match.
  assert.ok(!d.scan('id 110105194912310021').some((m) => m.type === 'cn_id'))
  // A long order number passes regex but fails checksum.
  assert.ok(!d.scan('order 123456789012345678').some((m) => m.type === 'cn_id'))
})

test('credit_card requires Luhn', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(d.scan('card 4111111111111111').some((m) => m.type === 'credit_card'))
  assert.ok(!d.scan('ref 4111111111111112').some((m) => m.type === 'credit_card'))
})

test('api_key shapes', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(d.scan('key sk-abcdef1234567890abcdef').some((m) => m.type === 'api_key'))
  assert.ok(d.scan('Bearer abcdef123456').some((m) => m.type === 'api_key'))
})

test('ssn and disabled detectors', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(d.scan('ssn 123-45-6789').some((m) => m.type === 'ssn'))
  const noSsn = det({ ...DEFAULT_ALL_ON, ssn: false })
  assert.ok(!noSsn.scan('ssn 123-45-6789').some((m) => m.type === 'ssn'))
})

test('ipv4 opt-in', () => {
  const d = det(DEFAULT_ALL_ON)
  assert.ok(!d.scan('host 192.168.1.10').some((m) => m.type === 'ipv4'))
  const withIp = det({ ...DEFAULT_ALL_ON, ipv4: true })
  assert.ok(withIp.scan('host 192.168.1.10').some((m) => m.type === 'ipv4'))
})

test('custom patterns compile, run, and invalid ones are skipped', () => {
  const d = det(DEFAULT_ALL_ON, [{ name: 'mrn', pattern: 'MRN-\\d{8}' }])
  assert.ok(d.scan('record MRN-00421125').some((m) => m.type === 'custom' && m.detector === 'mrn'))
  const bad = det(DEFAULT_ALL_ON, [{ name: 'boom', pattern: '[' }])
  assert.equal(bad.size, 7)
  const empty = det(DEFAULT_ALL_ON, [{ name: 'zero', pattern: 'a*' }])
  // 'a*' matches empty string -> skipped by the probe guard
  assert.equal(empty.size, 7)
})

test('collectStrings walks nested args', () => {
  const out = collectStrings({ a: { b: ['x', { c: 'y' }] }, d: 1, e: null })
  assert.deepEqual(out.sort(), ['x', 'y'])
})

test('countByType aggregates', () => {
  const d = det(DEFAULT_ALL_ON)
  const counts = countByType(d.scan('mail a@b.com ssn 123-45-6789'))
  assert.equal(counts.email, 1)
  assert.equal(counts.ssn, 1)
})

test('oversized strings are skipped', () => {
  const d = new PiiDetector(compileDetectors({ detectors: DEFAULT_ALL_ON }), 50)
  assert.deepEqual(d.scan('a'.repeat(80)), [])
})
