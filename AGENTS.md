# pi-acp (ACP adapter for pi-coding-agent)

This repository implements an **Agent Client Protocol (ACP)** adapter for **pi** (`@earendil-works/pi-coding-agent`) without modifying pi. It is a fork of svkozak/pi-acp 0.0.34, maintained for codeg and published to npm as `@spacering/pi-acp` (command `pi-acp`, the same as upstream's). Keep upstream's layout and prettier config: files the fork never touched stay byte-identical to upstream, so upstream changes merge cleanly.

- ACP side: **JSON-RPC 2.0 over stdio** using `@agentclientprotocol/sdk` (TypeScript)
- Pi side: spawn `pi --mode rpc` and communicate via **newline-delimited JSON** over stdio

## Architecture (MVP)

### 1 ACP session ↔ 1 pi subprocess

Pi RPC mode is effectively single-session, so the adapter maps:

- `session/new` → spawn a dedicated `pi --mode rpc` process
- `session/prompt` → send `{type:"prompt"}` to that process and stream events back as `session/update`
- `session/cancel` → send `{type:"abort"}`

### ACP server wiring (modeled after opencode)

Use `@agentclientprotocol/sdk`:

- `ndJsonStream(input, output)` to speak ACP over stdio
- `new AgentSideConnection((conn) => new PiAcpAgent(conn, config), stream)`

## Implementation constraints / decisions

- Do **not** implement ACP client-side FS/terminal delegation in MVP. Pi already reads/writes and executes locally.
- `mcpServers` reach pi's native MCP (pi 0.99+) through the pi extension in `src/pi-extension/mcp-bridge.ts`, which the adapter loads with `pi -e` (see `src/acp/mcp-bridge.ts`). The extension is built separately to `dist/mcp-bridge.mjs` and may import node built-ins only.
- Stream pi's assistant text as ACP `agent_message_chunk` and its thinking as `agent_thought_chunk`.
- Tool events: map pi tool execution events to ACP `tool_call` / `tool_call_update` (as text content).

## Dev workflow

- Install deps: `npm ci`
- Run in dev: `npm run dev` (builds first: the adapter loads its pi extension from `dist/`)
- Build: `npm run build`
- Smoke test (stdio, needs a real pi): `npm run smoke`
- Packed package smoke test (no pi needed): `npm run smoke:packed`
- Lint: `npm run lint`
- Format check: `npm run format:check`
- Test: `npm run test` (node:test via tsx; pi is faked at the RPC boundary)

## Manual testing notes

Once the adapter runs, it should behave like an ACP agent on stdio.

Quick sanity test (example):

```bashN
# Send initialize request via stdin (exact fields depend on ACP SDK version)
# echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}' | node dist/index.js
```

For real validation, test with an ACP client (e.g. Zed external agent).

## Coding guidelines

- Keep ACP protocol handling in `src/acp/*`.
- Keep pi RPC subprocess logic in `src/pi-rpc/*`.
- Prefer small translation functions (pi event → ACP session/update) with unit tests.
- Be strict about streaming and process cleanup (handle exit, drain stdout/stderr, timeouts).
- Avoid producing unnecessary comments! Use comments sparingly to explain non-obvious decisions, not to narrate code.
- Avoid using `any` in TypeScript; prefer explicit types and interfaces. Only use `any` when absolutely necessary (e.g. for untyped external data).

## Validation

- After making code edits, run formatting before finishing the task. Use `npm run format` when it is safe to format the whole worktree; otherwise use the narrowest safe formatter command for the files you touched.
- If formatting is skipped or fails, say so explicitly in the final response.

## Source control

- **DO NOT** commit unless explicitly asked!

## Client information

- Main ACP client is codeg (https://github.com/xintaofei/codeg); Zed should keep working

## References

- ACP protocol documentation and specs: https://agentclientprotocol.com and https://github.com/agentclientprotocol/agent-client-protocol
- pi RPC mode and extension API: https://github.com/earendil-works/pi
- Upstream adapter: https://github.com/svkozak/pi-acp
