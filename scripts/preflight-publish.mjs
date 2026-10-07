#!/usr/bin/env node
// Run by `prepublishOnly`, after the build: refuses to publish a package whose
// metadata or entry points are wrong. A first publish can barely be undone (npm
// limits unpublish after 24 hours and keeps the name taken), and a placeholder
// `repository` does not fail anything: it ships as a dead source link and a
// package nobody can file an issue against. So nothing here guesses or fills a
// default; it only stops the publish.
import { existsSync, readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

const URL_PLACEHOLDER = /[<>]|example\.com|YOUR[-_ ]|TODO/i
const problems = []

function requireFilled(label, value, placeholder) {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.push(`${label} is empty`)
    return
  }
  if (placeholder?.test(value)) problems.push(`${label} is still a placeholder: ${value}`)
}

requireFilled('name', pkg.name)
requireFilled('version', pkg.version)
requireFilled('description', pkg.description)
requireFilled('license', pkg.license)
requireFilled('author', pkg.author, /TODO|YOUR[-_ ]NAME/i)
requireFilled('repository.url', pkg.repository?.url, URL_PLACEHOLDER)
requireFilled('homepage', pkg.homepage, URL_PLACEHOLDER)
requireFilled('bugs.url', pkg.bugs?.url, URL_PLACEHOLDER)

// npm publishes a scoped package as restricted unless told otherwise: the first
// publish then fails with 402, or, on an account that has private packages,
// ships a package nobody else can install.
if (pkg.name?.startsWith('@') && pkg.publishConfig?.access !== 'public') {
  problems.push(`${pkg.name} is scoped: publishConfig.access must be "public"`)
}

// npm adds LICENSE to the tarball only when it exists; MIT without its text grants nothing.
if (!existsSync(new URL('LICENSE', root))) problems.push('LICENSE is missing')

// npm silently skips a `files` entry that does not exist.
for (const entry of pkg.files ?? []) {
  if (!existsSync(new URL(entry, root))) problems.push(`files entry "${entry}" does not exist`)
}

// Entry points must exist once built: npm publishes a bin pointing at nothing
// without complaint, and installs then fail with MODULE_NOT_FOUND. The pi
// extension the adapter loads with `pi -e` is an entry point too.
for (const [label, rel] of [
  ['main', pkg.main],
  ...Object.entries(pkg.bin ?? {}).map(([name, path]) => [`bin.${name}`, path]),
  ['pi extension', 'dist/mcp-bridge.mjs']
]) {
  if (rel && !existsSync(new URL(rel, root)))
    problems.push(`${label} points at ${rel}, which does not exist (npm run build)`)
}

if (problems.length > 0) {
  console.error('Publish preflight failed:\n')
  for (const p of problems) console.error(`  ✗ ${p}`)
  process.exit(1)
}

console.error(`✓ publish preflight passed: ${pkg.name}@${pkg.version}`)
