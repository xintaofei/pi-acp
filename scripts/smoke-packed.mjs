// Packs the package exactly as `npm publish` would, installs the tarball
// globally into a throwaway prefix, and talks ACP to the installed adapter.
// A file missing from `files`, a wrong `bin`/entry path, a dependency left out
// of `dependencies` or a version that `initialize` misreports fails here, before
// anything reaches npm. Needs no pi: `initialize` does not start it.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const work = mkdtempSync(join(tmpdir(), 'codeg-pi-acp-pack-'))

const win = process.platform === 'win32'

function npm(args) {
  // npm is a .cmd shim on Windows, which Node only runs through a shell, and a
  // shell gets the arguments joined as they are: quote every one, so a temp path
  // with spaces or `&` stays one literal argument.
  const res = spawnSync(win ? 'npm.cmd' : 'npm', win ? args.map(a => `"${a}"`) : args, {
    cwd: root,
    encoding: 'utf8',
    shell: win,
    stdio: ['ignore', 'pipe', 'inherit']
  })
  if (res.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${res.status ?? res.signal})`)
  return res.stdout.trim()
}

function fail(message) {
  console.error(`smoke-packed: ${message}`)
  process.exitCode = 1
}

try {
  // `prepack` (the build) prints to the same stdout before npm's JSON.
  const packed = npm(['pack', '--json', '--pack-destination', work])
  const [{ filename }] = JSON.parse(packed.slice(packed.search(/^\[$/m)))
  const prefix = join(work, 'prefix')
  npm(['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', join(work, filename)])
  const installed = join(npm(['root', '--global', '--prefix', prefix]), pkg.name)

  for (const rel of ['package.json', 'LICENSE', 'README.md', ...Object.values(pkg.bin), 'dist/codeg-bridge.mjs']) {
    if (!existsSync(join(installed, rel))) fail(`the packed package has no ${rel}`)
  }

  // Start the adapter the way a client does: through the bin npm linked (and so
  // its shebang) on macOS/Linux. On Windows npm's .cmd shim only wraps
  // `node <entry>`, which needs a shell to run, so node starts the entry there.
  const [binName, binPath] = Object.entries(pkg.bin)[0]
  const entry = join(installed, binPath)
  const shim = win ? join(prefix, `${binName}.cmd`) : join(prefix, 'bin', binName)
  if (!existsSync(shim)) fail(`npm linked no ${shim}`)
  const command = win ? [process.execPath, entry] : [shim]

  const version = spawnSync(command[0], [...command.slice(1), '--version'], { encoding: 'utf8' })
  if (version.stdout?.trim() !== pkg.version) {
    fail(`--version printed ${JSON.stringify(version.stdout)} ${version.error ?? version.stderr ?? ''}`)
  }

  const info = await initialize(command)
  if (info?.name !== pkg.name || info?.version !== pkg.version) {
    fail(`initialize reported agentInfo ${JSON.stringify(info)}`)
  }
  if (!process.exitCode)
    console.log(`smoke-packed: ${filename} installs and answers initialize as ${pkg.name}@${pkg.version}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}

function initialize(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('no initialize response within 20 s'))
    }, 20_000)
    let buffered = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => {
      buffered += chunk
      let end
      while ((end = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, end)
        buffered = buffered.slice(end + 1)
        const msg = JSON.parse(line)
        if (msg.id !== 1) continue
        clearTimeout(timer)
        child.stdin.end()
        child.kill()
        if (msg.error) reject(new Error(`initialize failed: ${JSON.stringify(msg.error)}`))
        else resolve(msg.result?.agentInfo)
      }
    })
    child.on('error', reject)
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } }) + '\n'
    )
  })
}
