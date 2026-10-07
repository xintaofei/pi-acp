# Contributing

## Getting started

```bash
npm ci
npm run typecheck
npm run lint
npm test               # no pi or API key needed: tests fake pi at the RPC boundary
npm run build
```

Node 22.19 or newer is required (pi's own minimum). Trying the adapter for real needs pi 0.99+ on `PATH`, set up
for a provider: `npm run smoke` drives one prompt through `dist/index.js`, and the other `scripts/smoke-*.mjs` cover
session load, compaction, export, modes and the queue.

## Before opening a pull request

```bash
npm run typecheck && npm run lint && npm run format:check && npm run build && npm test && npm run smoke:packed
```

CI runs the same steps on Ubuntu, macOS and Windows with Node 22 and 24.

## Keeping up with upstream

This repository carries [svkozak/pi-acp](https://github.com/svkozak/pi-acp)'s history up to v0.0.34, and the fork's
own commits sit on top. Upstream's layout and prettier config are kept on purpose: files the fork never touched are
byte-identical to upstream, so upstream fixes merge cleanly.

```bash
git remote add upstream https://github.com/svkozak/pi-acp.git
git fetch upstream
git merge upstream/main
```

Expect conflicts in `package.json` (name, version, dependencies) and in the files the fork changed most:
`src/acp/session.ts`, `src/acp/agent.ts` and `src/pi-rpc/process.ts`.

## Releasing (maintainers)

A release is two commands:

```bash
npm version patch        # or minor / major: bumps package.json and tags vX.Y.Z
git push --follow-tags
```

The tag starts `.github/workflows/release.yml`. It checks that the tag matches `package.json`, runs the checks on
Windows, macOS and Ubuntu, runs `npm publish`, and creates a GitHub Release.

Publishing uses npm **trusted publishing** (OIDC). The repository holds no npm token. GitHub issues a short-lived
credential at run time, npm accepts it for this repository's `release.yml`, and adds a provenance attestation.

One-time setup:

1. **Publish the first version by hand.** npm only offers trusted-publisher settings for a package that already
   exists. The package is `@spacering/pi-acp`, so log in to npm as `spacering` (with 2FA). Run
   `npm run format:check && npm run smoke:packed`, then `npm publish`; `prepublishOnly` builds and runs the preflight,
   typecheck, lint and tests before anything is uploaded. `publishConfig.access` is `public`: npm would otherwise
   publish a scoped package as restricted.
2. On npmjs.com, open `@spacering/pi-acp`'s **Settings → Trusted Publisher → GitHub Actions**. Set the user to
   `xintaofei` (the GitHub owner of this repository), the repository to `pi-acp` and the workflow filename to
   `release.yml`. Leave Environment empty.
3. Under **Settings → Publishing access**, choose "Require two-factor authentication and disallow tokens". From then
   on, unattended publishing goes only through `release.yml`.

Points that cost time when they go wrong:

- **The workflow's file name is part of its identity.** Renaming `release.yml` without updating npm's settings makes
  publishing fail with an authentication error that does not say why.
- **`repository.url` in `package.json` must match this GitHub repository exactly**, or no provenance attestation is
  generated.
- **codeg pins an exact version** of `@spacering/pi-acp` (`AgentType::Pi` in codeg's `src-tauri/src/acp/registry.rs`).
  Publishing does not change what codeg installs. Bump that pin in codeg after a release has been checked there.
