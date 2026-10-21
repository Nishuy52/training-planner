import { describe, expect, it } from 'vitest';
import { buildRequest, normalizePath, parseEnvFile, redact, resolveConfig } from '../../scripts/api-lib.mjs';

const cfg = { appUrl: 'https://training.example.workers.dev', clientId: 'id.access', clientSecret: 's3cret' };

describe('scripts/api-lib (service-token CLI helpers)', () => {
  it('parseEnvFile reads KEY=VALUE, skips comments, strips quotes and CRLF', () => {
    const text = '# comment\r\nCF_ACCESS_CLIENT_ID=abc.access\r\n\r\nexport CF_ACCESS_CLIENT_SECRET="x=y"\nAPP_URL=\'https://a.example\'\nnot a line\n';
    expect(parseEnvFile(text)).toEqual({ CF_ACCESS_CLIENT_ID: 'abc.access', CF_ACCESS_CLIENT_SECRET: 'x=y', APP_URL: 'https://a.example' });
  });

  it('resolveConfig: env wins over the file, APP_URL required, https only, both credentials required', () => {
    const file = { CF_ACCESS_CLIENT_ID: 'file-id', CF_ACCESS_CLIENT_SECRET: 'file-secret', APP_URL: 'https://training.example.workers.dev/' };
    expect(resolveConfig({ CF_ACCESS_CLIENT_ID: 'env-id' }, file)).toEqual({
      appUrl: 'https://training.example.workers.dev', clientId: 'env-id', clientSecret: 'file-secret',
    });
    expect(resolveConfig({ APP_URL: 'https://other.example' }, file).appUrl).toBe('https://other.example');
    expect(() => resolveConfig({}, { CF_ACCESS_CLIENT_ID: 'id', CF_ACCESS_CLIENT_SECRET: 's' })).toThrow(/APP_URL not set/);
    expect(() => resolveConfig({ APP_URL: 'http://training.example' }, file)).toThrow(/https/);
    expect(() => resolveConfig({ APP_URL: 'https://a.example' }, { CF_ACCESS_CLIENT_ID: 'only-id' })).toThrow(/CF_ACCESS_CLIENT_SECRET/);
    try {
      resolveConfig({ APP_URL: 'ftp://x' }, file);
    } catch (e) {
      expect(String(e)).not.toContain('file-secret');
    }
  });

  it('normalizePath accepts /api and api/, and repairs Git Bash path conversion', () => {
    expect(normalizePath('/api/state')).toBe('/api/state');
    expect(normalizePath('api/plan?days=14')).toBe('/api/plan?days=14');
    expect(normalizePath('C:/Program Files/Git/api/state')).toBe('/api/state');
    expect(() => normalizePath('/admin')).toThrow(/\/api/);
    expect(() => normalizePath('//evil.example/api/x')).toThrow();
  });

  it('buildRequest sends the service-token headers, JSON content type, and no redirects', () => {
    const { url, init } = buildRequest('get', '/api/routing-context?days=8', undefined, cfg);
    expect(url).toBe('https://training.example.workers.dev/api/routing-context?days=8');
    expect(init).toMatchObject({ method: 'GET', redirect: 'manual' });
    expect(init.headers).toEqual({
      'CF-Access-Client-Id': 'id.access', 'CF-Access-Client-Secret': 's3cret',
      'Content-Type': 'application/json', Accept: 'application/json',
    });
    expect(init.body).toBeUndefined();
  });

  it('buildRequest validates bodies and methods', () => {
    expect(buildRequest('POST', '/api/routes', ' { "id": "a" } ', cfg).init.body).toBe('{"id":"a"}');
    expect(buildRequest('POST', '/api/sync', undefined, cfg).init.body).toBe('{}');
    expect(() => buildRequest('POST', '/api/routes', '{bad', cfg)).toThrow(/valid JSON/);
    expect(() => buildRequest('GET', '/api/state', '{}', cfg)).toThrow(/no body/);
    expect(() => buildRequest('PATCH', '/api/state', undefined, cfg)).toThrow(/method/);
  });

  it('redact removes secrets from printed text', () => {
    expect(redact('id=id.access secret=s3cret', ['id.access', 's3cret', undefined])).toBe('id=[redacted] secret=[redacted]');
  });
});
