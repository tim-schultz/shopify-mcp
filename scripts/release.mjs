import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run this script with npm run release:pack.')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
const destination = join(root, 'release')
await mkdir(destination, { recursive: true })
const staging = await mkdtemp(join(destination, '.pack-'))
const smoke = await mkdtemp(join(tmpdir(), 'shop-search-release-'))

function npm(args, options = {}) {
  return execFileSync(process.execPath, [npmCli, ...args], {
    cwd: root, encoding: 'utf8', timeout: 120_000, stdio: 'inherit', ...options,
  })
}

async function checkMcp(bin) {
  const child = spawn(process.execPath, [bin, '--mcp'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let buffer = ''
  let diagnostics = ''
  let timer
  child.stderr.on('data', chunk => { diagnostics += String(chunk) })
  try {
    const tools = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Packaged MCP server timed out.')), 15_000)
      child.on('error', reject)
      child.on('exit', code => reject(new Error(`Packaged MCP exited ${code}: ${diagnostics}`)))
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
        protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'release-smoke', version: '1.0.0' },
      } }) + '\n')
    })
    assert.deepEqual(tools.map(tool => tool.name).sort(), ['product', 'search'])
    for (const tool of tools) assert.equal(tool.annotations.readOnlyHint, true)
  } finally { clearTimeout(timer); child.kill() }
}

try {
  // prepack runs the typecheck, synthetic tests and TypeScript build.
  npm(['pack', '--pack-destination', staging])
  const archives = (await readdir(staging)).filter(name => name.endsWith('.tgz'))
  assert.equal(archives.length, 1, 'Expected exactly one packed tarball.')
  const filename = archives[0]
  const tarball = join(staging, filename)

  // An empty cache and --offline prove all runtime dependencies are bundled.
  // No lifecycle scripts or live catalog requests run during recipient installation.
  npm(['install', '--global', '--prefix', smoke, '--offline', '--ignore-scripts', '--no-audit', '--no-fund',
    '--cache', join(smoke, 'empty-cache'), tarball], { stdio: 'pipe' })
  const installed = join(smoke, process.platform === 'win32' ? 'node_modules' : 'lib/node_modules', pkg.name)
  const bin = join(installed, 'dist/bin.js')
  const cli = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: smoke, encoding: 'utf8', timeout: 15_000 })
  assert.match(cli('--help'), /shop-search/)
  if (process.platform !== 'win32') {
    assert.match(execFileSync(join(smoke, 'bin/shop-search'), ['--help'], { encoding: 'utf8', timeout: 15_000 }), /shop-search/)
  }
  assert.match(cli('--llms'), /search/)
  assert.ok(JSON.parse(cli('search', '--schema', '--json')))
  const api = await import(pathToFileURL(join(installed, 'dist/index.js')).href)
  assert.equal(typeof api.search, 'function')
  assert.equal(typeof api.getProduct, 'function')
  for (const resource of ['SKILL.md', 'README.md', 'LICENSE', 'references/protocol.md']) {
    assert.ok((await readFile(join(installed, resource))).length, `Missing ${resource}`)
  }
  await checkMcp(bin)

  const bytes = await readFile(tarball)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  await copyFile(tarball, join(destination, filename))
  await writeFile(join(destination, 'SHA256SUMS'), `${sha256}  ${filename}\n`)
  let revision = 'local source'
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()
    revision = `${dirty ? 'Working tree based on' : 'Source commit'}: ${commit}`
  } catch { /* Source archives need not contain Git metadata. */ }
  await writeFile(join(destination, 'RELEASE_NOTES.md'), `Shopify Product Search ${pkg.version}\n\n${revision}\n\nRequires Node.js 22+ and npm. Runtime dependencies are bundled.\n\nDownload ${filename} and SHA256SUMS from this release, then verify and install:\n\n\`\`\`sh\nshasum -a 256 -c SHA256SUMS\nnpm install --global --offline --ignore-scripts ./${filename}\nshop-search --help\n\`\`\`\n\nLinux users can also verify with \`sha256sum --check SHA256SUMS\`. PowerShell users can compare \`(Get-FileHash ./${filename} -Algorithm SHA256).Hash\` with SHA256SUMS.\n\nThe package includes the Agent Skill and supports \`shop-search --mcp\`. Search/product commands are read-only and no npm registry publication is required.\n`)
  console.log(JSON.stringify({ tarball: join('release', filename), bytes: bytes.length, sha256, offlineInstall: 'PASS', cli: 'PASS', library: 'PASS', skill: 'PASS', mcp: 'PASS' }, null, 2))
} finally {
  await rm(staging, { recursive: true, force: true })
  await rm(smoke, { recursive: true, force: true })
}
