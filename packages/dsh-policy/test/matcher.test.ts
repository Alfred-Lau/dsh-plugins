import test from 'node:test'
import assert from 'node:assert/strict'
import { globToRegExp, extractCommands, extractPaths, isAbsolutePath } from '../lib/matcher.js'

test('glob: /etc/** matches everything below but not /etc itself', () => {
  const re = globToRegExp('/etc/**')
  assert.ok(re.test('/etc/passwd'))
  assert.ok(re.test('/etc/nginx/nginx.conf'))
  assert.ok(!re.test('/etc'))
  assert.ok(!re.test('/usr/etc/x'))
})

test('glob: **/ prefix matches zero or more segments', () => {
  const re = globToRegExp('**/.env')
  assert.ok(re.test('.env'))
  assert.ok(re.test('/a/.env'))
  assert.ok(re.test('/a/b/.env'))
  assert.ok(!re.test('/a/b.env'))
})

test('glob: * stays within a single path segment', () => {
  const re = globToRegExp('*.ts')
  assert.ok(re.test('a.ts'))
  assert.ok(!re.test('dir/a.ts'))
  const deep = globToRegExp('src/**/*.test.ts')
  assert.ok(deep.test('src/a/b.test.ts'))
  assert.ok(deep.test('src/x.test.ts'))
  assert.ok(!deep.test('lib/a.test.ts'))
})

test('glob: ? matches exactly one non-separator char; specials are escaped', () => {
  assert.ok(globToRegExp('file?.txt').test('file1.txt'))
  assert.ok(!globToRegExp('file?.txt').test('file10.txt'))
  assert.ok(globToRegExp('a+b.txt').test('a+b.txt'))
  assert.ok(!globToRegExp('a+b.txt').test('aab.txt'))
})

test('command extraction pulls string values under command args', () => {
  const cmds = extractCommands({
    command: 'git push --force',
    nested: { cmd: ['pnpm test', 'echo hi'] },
    ignored: 'not a command',
  })
  assert.deepEqual(cmds, ['git push --force', 'pnpm test', 'echo hi'])
})

test('path extraction: named path args + standalone absolute paths', () => {
  const paths = extractPaths({
    file_path: '/root/.ssh/id_rsa',
    note: 'see /etc/passwd for details',
    relative: 'src/a.ts',
  })
  assert.ok(paths.includes('/root/.ssh/id_rsa'))
  assert.ok(paths.includes('/etc/passwd'))
  assert.ok(!paths.includes('src/a.ts'), 'relative paths are not extracted')
})

test('windows separators are normalized before matching', () => {
  const paths = extractPaths({ path: 'C:\\Users\\x\\secrets.txt' })
  assert.ok(paths.includes('C:/Users/x/secrets.txt'))
  assert.ok(isAbsolutePath('C:\\temp\\f'))
  assert.ok(isAbsolutePath('/usr/bin'))
  assert.ok(!isAbsolutePath('usr/bin'))
})
