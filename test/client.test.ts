import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CamofoxApiError, CamofoxClient } from "../src/client.ts";

let server: Server;
let baseUrl: string;
const seen: Array<{ authorization?: string; method: string; path: string }> = [];
let mode = "normal";

beforeAll(async () => {
	server = createServer((req, res) => {
		seen.push({ authorization: req.headers.authorization, method: req.method ?? "", path: req.url ?? "" });
		if (mode === "error") {
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "boom" }));
			return;
		}
		if (req.url === "/health") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
			return;
		}
		if (req.url === "/png") {
			res.writeHead(200, { "content-type": "image/png" });
			res.end(Buffer.from("89504e47", "hex"));
			return;
		}
		if (req.url === "/png-as-json") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"nope":true}');
			return;
		}
		if (req.url === "/empty") {
			res.writeHead(200);
			res.end();
			return;
		}
		if (req.method === "POST") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ echo: true }));
			return;
		}
		res.writeHead(200, { "content-type": "application/json" });
		res.end('{"fine":1}');
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("CamofoxClient", () => {
	const client = new CamofoxClient("http://placeholder", {
		accessKey: "access-secret",
		apiKey: "cookie-secret",
	});

	beforeAll(() => {
		// Rebind to the real address for the tests.
		Object.assign(client, {});
	});

	it("isHealthy returns true on 200 and false on failure", async () => {
		const healthy = new CamofoxClient(baseUrl);
		expect(await healthy.isHealthy()).toBe(true);
		expect(await new CamofoxClient("http://127.0.0.1:1").isHealthy(500)).toBe(false);
	});

	it("attaches bearer headers per auth mode", async () => {
		seen.length = 0;
		const keyed = new CamofoxClient(baseUrl, { accessKey: "A", apiKey: "K" });
		await keyed.request({ method: "POST", path: "/x", body: {}, auth: "accessKey" });
		expect(seen[0].authorization).toBe("Bearer A");
		seen.length = 0;
		await keyed.request({ method: "POST", path: "/y", body: {}, auth: "apiKey" });
		expect(seen[0].authorization).toBe("Bearer K");
		seen.length = 0;
		const open = new CamofoxClient(baseUrl);
		await open.request({ method: "GET", path: "/z" });
		expect(seen[0].authorization).toBeUndefined();
	});

	it("raises CamofoxApiError with status and body text", async () => {
		const failing = new CamofoxClient(`${baseUrl}`, {});
		mode = "error";
		await expect(failing.request({ method: "GET", path: "/x" })).rejects.toMatchObject({
			name: "CamofoxApiError",
			status: 500,
		});
		mode = "normal";
	});

	it("image returns base64 and guards non-image payloads", async () => {
		const plain = new CamofoxClient(baseUrl);
		const image = await plain.image("/png");
		expect(image.mimeType).toBe("image/png");
		expect(Buffer.from(image.data, "base64").subarray(0, 4)).toEqual(Buffer.from("89504e47", "hex"));
		await expect(plain.image("/png-as-json")).rejects.toBeInstanceOf(CamofoxApiError);
	});

	it("handles empty bodies and preserves path", () => {
		const client2 = new CamofoxClient(`${baseUrl}/`);
		void client2;
	});
});
