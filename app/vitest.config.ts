import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

// All tests (test/domain and test/integration) run inside workerd via the
// Workers pool; bindings (DB, ASSETS, vars) come from wrangler.jsonc and are
// local-only, so the database_id is never contacted. wrangler.jsonc carries the
// production Access vars, so the pool blanks them: tests default to "Access not
// configured" and auth tests set their own values per request.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // The Live Session Durable Object reads Telegram config from its own env (it runs in the main Worker), so the
      // test values from test/integration/helpers.ts are set here too; tests route Telegram calls to a fake.
      miniflare: { bindings: { ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '', TELEGRAM_BOT_TOKEN: '123456:TEST-TOKEN-never-real', TELEGRAM_CHAT_ID: '4242' } },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
  },
});
