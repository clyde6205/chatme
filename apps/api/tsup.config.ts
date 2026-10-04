import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { server: 'src/server.ts', migrate: 'src/db/migrate-cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Workspace packages ship TypeScript source; bundle them. Third-party deps stay external.
  noExternal: [/^@chatme\//],
});
