import { describe, expect, it } from "vitest";
import { attackFlags, hitsLogin, normalizePath, normalizeQuery } from "../src/loop/sanitize";

describe("sanitize", () => {
  it("flags attack patterns, including encoded ones", () => {
    expect(attackFlags("/search?q=1%27%20UNION%20SELECT%20password%20FROM%20users--").has_sqli_pattern).toBe(true);
    expect(attackFlags("/../../etc/passwd").has_traversal_pattern).toBe(true);
    expect(attackFlags("/p?x=%3Cscript%3Ealert(1)%3C/script%3E").has_xss_pattern).toBe(true);
    expect(attackFlags("/api?cmd=;cat /etc/hosts").has_rce_pattern).toBe(true);
    expect(attackFlags("/blog/select-the-best-union-jobs").has_sqli_pattern).toBe(false);
  });

  it("collapses attack paths and ids but keeps readable structure", () => {
    expect(normalizePath("/../../etc/passwd")).toBe("[attack pattern removed]");
    expect(normalizePath("/lectures/1234")).toBe("/lectures/*");
    expect(normalizePath("/u/3f2504e0-4f89-11d3-9a0c-0305e82c3301/edit")).toBe("/u/*/edit");
    expect(normalizePath("/blog/launch")).toBe("/blog/launch");
  });

  it("keeps query parameter names, never values", () => {
    expect(normalizeQuery("q=my+secret+search&page=2")).toBe("?q=*&page=*");
    expect(normalizeQuery("q=1' UNION SELECT 1--")).toBe("?q=*");
    expect(normalizeQuery("")).toBe("");
  });

  it("recognizes login paths", () => {
    expect(hitsLogin("/login")).toBe(true);
    expect(hitsLogin("/wp-login.php")).toBe(true);
    expect(hitsLogin("/blog/logins-are-hard")).toBe(false);
  });
});
