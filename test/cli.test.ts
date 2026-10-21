import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const run = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', bin, ...args], { encoding: 'utf8', timeout: 10_000 })

test('CLI provides help and an agent manifest without network access', () => {
  const help = run('--help')
  assert.equal(help.status, 0, help.stderr)
  assert.match(help.stdout, /search/)
  assert.match(help.stdout, /product/)
  const manifest = run('--llms')
  assert.equal(manifest.status, 0, manifest.stderr)
  assert.match(manifest.stdout, /search/)
  assert.match(manifest.stdout, /product/)
})
test('command schemas advertise size selection, bounds and typed output', () => {
  const result = run('search', '--schema', '--json')
  assert.equal(result.status, 0, result.stderr)
  const raw = JSON.parse(result.stdout)
  assert.match(JSON.stringify(raw), /sizeOption/)
  assert.match(JSON.stringify(raw), /maxStores/)
  const product = run('product', '--schema', '--json')
  assert.equal(product.status, 0, product.stderr)
  assert.match(product.stdout, /select/)
})
test('invalid limits, market context and domains fail before a catalog request', () => {
  for (const args of [
    ['search', 'shoes', '--max-stores', '100'],
    ['search', 'shoes', '--country', 'usa'],
    ['product', '--shop', 'localhost', '--id', 'gid://shopify/Product/123'],
  ]) {
    const result = run(...args, '--json')
    assert.notEqual(result.status, 0)
    assert.ok(result.stdout || result.stderr)
  }
})
test('MCP stdio exposes only catalog workflows and marks them read-only', { timeout: 10_000 }, async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', bin, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let diagnostics = ''
  child.stderr.on('data', chunk => { diagnostics += String(chunk) })
  try {
    const tools = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', code => reject(new Error(`MCP exited ${code}: ${diagnostics}`)))
      child.stdout.on('data', chunk => {
        buffer += String(chunk)
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
          if (!line.trim()) continue
          try {
            const reply = JSON.parse(line)
            if (reply.id === 1) {
              assert.ok(!reply.error, JSON.stringify(reply.error))
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
              child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n')
            }
            if (reply.id === 2) {
              assert.ok(!reply.error, JSON.stringify(reply.error))
              resolve(reply.result.tools)
            }
          } catch (error) { reject(error) }
        }
      })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'offline-test', version: '1.0.0' },
      } }) + '\n')
    })
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['product', 'search'])
    for (const tool of tools) assert.equal((tool.annotations as Record<string, unknown>).readOnlyHint, true)
  } finally { child.kill() }
})
