import { describe, expect, it } from 'vitest';
import headers from '../../public/_headers?raw';
import indexHtml from '../../public/index.html?raw';
import appJs from '../../public/app.js?raw';

// public/_headers is applied by Workers Static Assets to asset responses (not to Worker-generated /api responses).
describe('static asset security headers', () => {
  const lines = headers.split(/\r?\n/);
  const rule = lines.slice(lines.indexOf('/*') + 1).filter((l) => /^\s+\S/.test(l)).map((l) => l.trim());

  it('applies a strict CSP, nosniff and no-referrer to every asset', () => {
    expect(lines).toContain('/*');
    expect(rule).toContain(
      "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(rule).toContain('X-Content-Type-Options: nosniff');
    expect(rule).toContain('Referrer-Policy: no-referrer');
  });

  it('the page has no inline scripts or inline event handlers the CSP would block', () => {
    for (const m of indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\bsrc=/);
      expect(m[2]!.trim()).toBe('');
    }
    for (const src of [indexHtml, appJs]) {
      expect(src).not.toMatch(/<[^>]*\son[a-z]+\s*=/i);
      expect(src).not.toMatch(/javascript:/i);
    }
  });
});
