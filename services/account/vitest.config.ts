import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.toml' },
      miniflare: {
        bindings: {
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-google-secret',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
        },
      },
    }),
  ],
  test: {
    include: ['test/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
}))
