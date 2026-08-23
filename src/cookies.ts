/**
 * Parse Netscape-format cookies.txt files into Playwright cookie objects,
 * matching the semantics of camofox's own mcp/lib/cookies.mjs:
 * - `#` comment lines are skipped, except `#HttpOnly_` prefixed rows,
 * - rows are tab-separated: domain, flag, path, secure, expiry, name, value.
 */

export interface ParsedCookie {
	name: string;
	value: string;
	domain: string;
	path: string;
	secure: boolean;
	httpOnly: boolean;
	expires: number;
}

export function parseNetscapeCookies(content: string, domainSuffix?: string): ParsedCookie[] {
	const cookies: ParsedCookie[] = [];
	for (const rawLine of content.split(/\r?\n/)) {
		let line = rawLine;
		let httpOnly = false;
		if (line.startsWith("#HttpOnly_")) {
			httpOnly = true;
			line = line.slice("#HttpOnly_".length);
		} else if (line.startsWith("#") || line.trim().length === 0) {
			continue;
		}
		const parts = line.split("\t");
		if (parts.length < 7) continue;
		const [domain, _flag, path, secure, expiry, name, ...valueParts] = parts;
		const value = valueParts.join("\t");
		if (!domain || !path || !name || value === undefined) continue;
		if (domainSuffix && !domain.endsWith(domainSuffix)) continue;
		const expires = Number(expiry);
		cookies.push({
			name,
			value,
			domain,
			path,
			secure: secure === "TRUE",
			httpOnly,
			expires: Number.isSafeInteger(expires) && expires > 0 ? expires : -1,
		});
	}
	return cookies;
}
