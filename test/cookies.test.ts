import { describe, expect, it } from "vitest";
import { parseNetscapeCookies } from "../src/cookies.ts";

const SAMPLE = [
	"# Netscape HTTP Cookie File",
	"#HttpOnly_.example.com\tTRUE\t/\tTRUE\t1893456000\tsid\thunter2",
	".example.com\tTRUE\t/\tTRUE\t1893456000\ttheme\tdark",
	"sub.example.com\tFALSE\t/account\tTRUE\t0\ttracker\txyz",
	"",
	"# just a comment",
].join("\n");

describe("parseNetscapeCookies", () => {
	it("parses rows including #HttpOnly_ prefixed ones", () => {
		const cookies = parseNetscapeCookies(SAMPLE);
		expect(cookies).toHaveLength(3);
		const httpOnly = cookies.find((cookie) => cookie.name === "sid");
		expect(httpOnly?.httpOnly).toBe(true);
		expect(httpOnly?.domain).toBe(".example.com");
		expect(httpOnly?.value).toBe("hunter2");
	});

	it("skips comments and malformed rows", () => {
		const cookies = parseNetscapeCookies("# comment\nbroken-row\n.a.com\tTRUE\t/\tTRUE\t123\tok\tv");
		expect(cookies).toHaveLength(1);
		expect(cookies[0].name).toBe("ok");
	});

	it("filters by domain suffix when given", () => {
		const cookies = parseNetscapeCookies(SAMPLE, "sub.example.com");
		expect(cookies.map((cookie) => cookie.name)).toEqual(["tracker"]);
	});

	it("maps secure/expiry fields", () => {
		const [cookie] = parseNetscapeCookies(".a.com\tTRUE\t/path\tTRUE\t123\tname\tval");
		expect(cookie.secure).toBe(true);
		expect(cookie.path).toBe("/path");
		expect(cookie.expires).toBe(123);
	});
});
