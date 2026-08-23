/** Minimal typed REST client for the camofox-browser HTTP API. */

export interface CamofoxKeys {
	accessKey?: string;
	apiKey?: string;
}

export type AuthMode = "accessKey" | "apiKey" | "none";

export interface RequestOptions {
	method: "GET" | "POST" | "DELETE";
	path: string;
	body?: unknown;
	auth?: AuthMode;
	/** Overall deadline for this request. Default 180s (first browser start downloads Camoufox). */
	timeoutMs?: number;
}

export class CamofoxApiError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.name = "CamofoxApiError";
		this.status = status;
	}
}

function authHeaders(mode: AuthMode, keys: CamofoxKeys): Record<string, string> {
	if (mode === "accessKey") return keys.accessKey ? { authorization: `Bearer ${keys.accessKey}` } : {};
	if (mode === "apiKey") return { authorization: `Bearer ${keys.apiKey ?? ""}` };
	return {};
}

export class CamofoxClient {
	private readonly baseUrl: string;
	private readonly keys: CamofoxKeys;
	private readonly fetchImpl: typeof fetch;

	constructor(baseUrl: string, keys: CamofoxKeys = {}, fetchImpl: typeof fetch = fetch) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.keys = keys;
		this.fetchImpl = fetchImpl;
	}

	/** True when /health responds 200 within timeoutMs. */
	async isHealthy(timeoutMs = 2_000): Promise<boolean> {
		try {
			const response = await this.fetchImpl(`${this.baseUrl}/health`, {
				signal: AbortSignal.timeout(timeoutMs),
			});
			return response.ok;
		} catch {
			return false;
		}
	}

	/** JSON request. Non-2xx raises CamofoxApiError with the response text. */
	async request(options: RequestOptions): Promise<unknown> {
		const headers = {
			"content-type": "application/json",
			...authHeaders(options.auth ?? "accessKey", this.keys),
		};
		const response = await this.fetchImpl(`${this.baseUrl}${options.path}`, {
			method: options.method,
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: AbortSignal.timeout(options.timeoutMs ?? 180_000),
		});
		const text = await response.text();
		if (!response.ok) {
			throw new CamofoxApiError(response.status, `${response.status}: ${text.slice(0, 2000)}`);
		}
		if (text.length === 0) return {};
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return { raw: text };
		}
	}

	/**
	 * Fetch an image endpoint; returns base64 data plus mimeType.
	 * Guards against servers answering image routes with JSON errors.
	 */
	async image(
		path: string,
		auth: AuthMode = "accessKey",
		timeoutMs = 120_000,
	): Promise<{ data: string; mimeType: string }> {
		const headers = authHeaders(auth, this.keys);
		const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			const text = await response.text();
			throw new CamofoxApiError(response.status, `${response.status}: ${text.slice(0, 2000)}`);
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.startsWith("image/")) {
			const text = await response.text();
			throw new CamofoxApiError(response.status, `Expected an image response, got: ${text.slice(0, 500)}`);
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		return { data: buffer.toString("base64"), mimeType: contentType };
	}
}
