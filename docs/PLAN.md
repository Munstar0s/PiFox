# PiFox — Implementation Plan

Pi extension that makes the Camofox anti-detection browser part of the Pi
agent: lazy lifecycle management (no always-on server), native registered
tools, distributed as an installable pi package.

## Ground truth (inspected from jo-inc/camofox-browser @ HEAD)

- Published on npm as **`@askjo/camofox-browser`** (v1.14.0). Entry:
  `bin/camofox-browser.js` → `server.js`. Pure Node HTTP server (no build step).
- **REST API** (OpenAPI at `/openapi.json`): tabs CRUD, navigate (URLs +
  search macros), accessibility snapshots with element refs, click/type/press,
  scroll, screenshot, evaluate JS, extract, links/images/downloads, cookie
  import, YouTube transcripts, traces, sessions.
- **Auth**: `CAMOFOX_ACCESS_KEY` gates all routes; `CAMOFOX_API_KEY` gates
  cookie import. Both optional (loopback dev default is ungated).
- **`GET /health`** → 200 `{ok:true,...}` / 503 while recovering. Unauthenticated
  always. Perfect readiness probe.
- **Graceful SIGTERM** handling built in (`gracefulShutdown`).
- **Browser engine lazy-launches inside camofox** on first tab creation;
  first ever run downloads Camoufox (~300 MB, one time).
- Upstream ships `mcp/lib/tool-contracts.mjs` — canonical JSON schemas +
  REST mappings for 11 tools shared by their MCP and OpenClaw hosts. We mirror
  these contracts (schemas/routes/auth/response shaping) so behavior matches
  the reference hosts exactly.
- Config via env: `CAMOFOX_PORT` (9377), `CAMOFOX_BIND_HOST`,
  `CAMOFOX_COOKIES_DIR`, `CAMOFOX_UPLOADS_DIR`, `CAMOFOX_PROFILE_DIR`, etc.

## Architecture

```
Pi agent session
   │  pi.registerTool() × 13
   ▼
PiFox extension (this package)
   │
   ├─ ProcessManager   owns the camofox SERVER process lifecycle
   │    • ensureStarted(): adopt-or-spawn
   │    • idle teardown (SIGTERM → SIGKILL escalation)
   │    • session_shutdown cleanup
   ├─ CamofoxClient    typed REST calls (fetch, bearer auth)
   └─ tools.ts         typebox schemas → REST mapping (mirrors upstream contracts)
        ▼
@askjo/camofox-browser  spawned as child of the pi process (127.0.0.1)
        ▼
Camoufox engine (lazy inside camofox)
```

### Lifecycle policy (the core requirement)

1. **Lazy**: nothing runs until the first camofox tool call in a session.
2. **Adopt-or-spawn**: `ensureStarted()` probes `127.0.0.1:$PORT/health`.
   Healthy → adopt the running instance (never kills a server it didn't
   start — this also makes concurrent pi sessions share one camofox).
   Not healthy → spawn `node <resolved camofox bin>` bound to loopback with
   managed env, logs appended to `~/.pifox/camofox.log`.
3. **Warm while working**: every tool call touches the last-used timestamp.
4. **Idle teardown**: a 30 s sweeper stops the spawned server after
   `idleShutdownMs` (default 10 min) of no tool activity. Escalates
   SIGTERM → SIGKILL after 10 s.
5. **Session hygiene**: `session_shutdown` stops the managed server (unless
   `PIFOX_KEEP_ALIVE=1`). Adopted servers are left untouched.
6. **Crash awareness**: unexpected child exit marks state stopped and is
   surfaced via `pifox_status`; next tool call transparently restarts.

## Tools (13)

The upstream canonical 11 (identical names/schemas so docs and habits carry
over): `camofox_create_tab`, `camofox_snapshot`, `camofox_click`,
`camofox_type`, `camofox_navigate`, `camofox_scroll`, `camofox_screenshot`,
`camofox_close_tab`, `camofox_evaluate`, `camofox_list_tabs`,
`camofox_import_cookies`.

Plus two lifecycle tools unique to PiFox:
- `pifox_status` — server state, uptime, pid, tabs, memory, idle countdown.
- `pifox_shutdown` — immediate stop of the managed server.

Response handling follows upstream semantics: snapshots split the embedded
screenshot into an image content block; screenshots return an image block and
are additionally written to a temp file when `savePath` is given; all other
payloads are returned as compact JSON, truncated with pi's truncation helpers
(50 KB / 2000 lines) to protect context.

## Configuration (env, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PIFOX_PORT` | `9377` | Server port (also adopted-instance probe target) |
| `PIFOX_IDLE_SHUTDOWN_MS` | `600000` | Idle teardown delay |
| `PIFOX_KEEP_ALIVE` | unset | `1` disables idle teardown |
| `PIFOX_USER_ID` | `pi` | Camofox session partition |
| `PIFOX_ACCESS_KEY` | unset | Set on spawned server + sent as bearer |
| `PIFOX_API_KEY` | unset | Cookie-import key (spawned server + header) |
| `PIFOX_CAMOFOX_ENTRY` | auto-resolved | Explicit path to camofox entry js |

Auto-resolution walks up from `import.meta.url` to find
`node_modules/@askjo/camofox-browser/bin/camofox-browser.js` — works both in
this repo and when installed under `~/.pi/agent/npm/<pkg>/`.

## Packaging

- `package.json`: `"keywords": ["pi-package"]`, `pi.extensions:
  ["./src/index.ts"]`, runtime dep `@askjo/camofox-browser` pinned exact,
  core pi packages (`@earendil-works/pi-coding-agent`, `typebox`) as
  `peerDependencies: "*"` per pi packaging rules (pi provides them; never
  bundled).
- Install paths supported:
  1. `pi install npm:<name>` / git URL (official route; deps auto-installed),
  2. symlink/clone into `~/.pi/agent/extensions/PiFox` (auto-discovery),
     with `npm install` run once inside.

## Testing strategy

1. **Unit/integration (vitest, no network)**: fake camofox REST server
   fixture; ProcessManager spawn/adopt/idle-teardown/crash tests with short
   timers; client schema→request mapping tests; truncation and image handling.
2. **Real end-to-end (no LLM)**: standalone script drives the built extension
   manager against the REAL camofox server: ensureStarted → create tab →
   navigate example.com → snapshot → screenshot → idle shutdown.
3. **Pi integration (no network)**: SDK harness (`createAgentSession`) loads
   the extension via factories, verifies all 13 tools register and execute
   through the agent tool path against the fixture server.
4. **Install verification**: link into `~/.pi/agent/extensions/PiFox`, launch
   pi headlessly to confirm the extension loads without errors.

## Milestones

1. M1 scaffold + config + client (TDD)
2. M2 ProcessManager (TDD)
3. M3 tools + extension entry (TDD)
4. M4 real-camofox end-to-end script
5. M5 pi harness test + install + final verification
