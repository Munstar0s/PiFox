# PiFox

**Pi extension: the [Camofox](https://github.com/jo-inc/camofox-browser)
anti-detection browser as native agent tools — with lazy lifecycle
management.**

PiFox registers 13 first-class tools (`camofox_create_tab`, `camofox_snapshot`,
`camofox_click`, … plus `pifox_status` / `pifox_shutdown`) directly into the Pi
agent. The Camofox server is **not** a permanent daemon: PiFox launches it on
the first tool call, keeps it warm while the agent browses, and tears it down
after an idle timeout or when the session ends. Nothing runs while pi sits
idle.

## Why

- **Zero standing cost** — no always-on browser server; memory is used only
  during active browsing.
- **Native integration** — tools are registered via `pi.registerTool()`, so
  the model sees typed schemas, and results flow through pi's normal tool
  pipeline (including image content blocks for screenshots).
- **Anti-detection browsing** — Camoufox spoofs fingerprints at the C++ level,
  beating bot detection that blocks plain Playwright/Chrome.
- **Adopt, don't fight** — if a Camofox server is already running on the port,
  PiFox adopts it instead of spawning a second one (and never kills a server
  it didn't start).

## Tools

The 11 canonical Camofox tools (schemas mirror upstream's shared tool
contracts) plus two lifecycle tools:

| Tool | Purpose |
|---|---|
| `camofox_create_tab` | Open a tab at a URL; returns `tabId` |
| `camofox_snapshot` | Accessibility snapshot with element refs (`e1`, `e2`, …) + screenshot |
| `camofox_click` | Click by ref or CSS selector |
| `camofox_type` | Type text (optional Enter) |
| `camofox_navigate` | Navigate to URL or search macro (`@google_search`, …) |
| `camofox_scroll` | Scroll up/down/left/right |
| `camofox_screenshot` | Screenshot as inline image (+ optional `savePath`) |
| `camofox_close_tab` | Close a tab |
| `camofox_evaluate` | Run JS in page context |
| `camofox_list_tabs` | List open tabs |
| `camofox_import_cookies` | Import Netscape cookies.txt for authenticated browsing |
| `pifox_status` | Server state, pid, uptime, idle countdown |
| `pifox_shutdown` | Stop the managed server immediately |

Slash command: `/camofox status|start|stop`.

## Install

As an installable pi package (recommended):

```sh
pi install npm:@munstar0s/pifox        # or git:github.com/Munstar0s/pifox
```

Or auto-discovery: clone/symlink this repo into your global extensions
directory and install dependencies once:

```sh
ln -s /path/to/PiFox ~/.pi/agent/extensions/PiFox
cd ~/.pi/agent/extensions/PiFox && npm install
```

The npm dependency `@askjo/camofox-browser` is installed with the package;
the ~300MB Camoufox engine binary downloads automatically on first browser
start (one time).

## Configuration (environment, all optional)

| Variable | Default | Meaning |
|---|---|---|
| `PIFOX_PORT` | `9377` | Server port; also the adoption probe target |
| `PIFOX_IDLE_SHUTDOWN_MS` | `600000` | Idle teardown delay for managed servers |
| `PIFOX_KEEP_ALIVE` | unset | `1` disables idle teardown entirely |
| `PIFOX_USER_ID` | `pi` | Camofox session partition |
| `PIFOX_SESSION_KEY` | `default` | Tab partition within the session |
| `PIFOX_ACCESS_KEY` | unset | Bearer key set on the spawned server + sent on requests |
| `PIFOX_API_KEY` | unset | Enables cookie import |
| `PIFOX_CAMOFOX_ENTRY` | auto-resolved | Explicit path to camofox's entry script |
| `PIFOX_HOME` | `~/.pifox` | Where managed-server logs are written |

## Lifecycle details

1. First camofox tool call → health probe on `127.0.0.1:$PIFOX_PORT`.
2. Healthy → **adopt** (never killed by PiFox). Unhealthy → **spawn** a
   managed instance bound to loopback with logs in `~/.pifox/camofox.log`.
3. Every tool call refreshes the last-used timestamp.
4. A sweeper stops managed servers after the idle timeout
   (SIGTERM → SIGKILL escalation); `session_shutdown` stops them too.
5. Unexpected child exits are surfaced via `pifox_status`; the next call
   transparently restarts.

## Development

```sh
npm install
npm run check    # biome + tsc
npm test         # unit/integration against a fake camofox REST server
RUN_E2E=1 npx vitest run test/e2e/   # real-camofox end-to-end
```

## License

MIT
