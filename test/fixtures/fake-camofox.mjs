// Minimal fake of the camofox REST surface for fast deterministic tests.
// Usage: node fake-camofox.mjs <port> [crashAfterMs]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.CAMOFOX_PORT ?? 9390);
const crashAfterMs = process.argv[3] ? Number(process.argv[3]) : 0;
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

const tabs = new Map();
let nextId = 1;

function readBody(req) {
	return new Promise((resolve) => {
		const chunks = [];
		req.on("data", (chunk) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf8");
			resolve(raw ? JSON.parse(raw) : {});
		});
	});
}

const server = createServer((req, res) => {
	void (async () => {
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const send = (status, payload) => {
			res.writeHead(status, { "content-type": "application/json" });
			res.end(JSON.stringify(payload));
		};
		const parts = url.pathname.split("/").filter(Boolean);

		if (req.url === "/health") return send(200, { ok: true, engine: "fake" });

		if (req.method === "POST" && req.url === "/tabs") {
			const body = await readBody(req);
			const tabId = `t${nextId++}`;
			tabs.set(tabId, { tabId, url: body.url ?? "about:blank", userId: body.userId });
			return send(200, { tabId, url: body.url });
		}
		if (req.method === "GET" && req.url?.startsWith("/tabs") && parts.length === 1) {
			return send(200, { tabs: [...tabs.values()] });
		}
		if (parts[0] === "tabs" && parts[1]) {
			const tabId = parts[1];
			const rest = parts.slice(2).join("/");
			if (req.method === "DELETE" && rest.length === 0) {
				tabs.delete(tabId);
				return send(200, { closed: tabId });
			}
			if (rest === "screenshot" && req.method === "GET") {
				res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
				return res.end(PNG);
			}
			if (rest === "snapshot" && req.method === "GET") {
				return send(200, {
					text: `Snapshot of ${tabs.get(tabId)?.url ?? "?"}`,
					refs: { e1: { role: "link", name: "Example" } },
					screenshot: { data: PNG.toString("base64"), mimeType: "image/png" },
				});
			}
			if (req.method === "POST") {
				const body = await readBody(req);
				return send(200, { ok: true, action: rest, ...body });
			}
		}
		if (parts[0] === "sessions" && parts[2] === "cookies" && req.method === "POST") {
			const body = await readBody(req);
			return send(200, { imported: Array.isArray(body.cookies) ? body.cookies.length : 0 });
		}
		send(404, { error: `no route: ${req.method} ${req.url}` });
	})().catch(() => {
		res.writeHead(500);
		res.end();
	});
});

server.listen(port, "127.0.0.1");
if (crashAfterMs > 0) setTimeout(() => process.exit(1), crashAfterMs);
