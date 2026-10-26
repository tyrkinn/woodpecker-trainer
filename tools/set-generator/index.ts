#!/usr/bin/env -S npx tsx
// Точка входа, чтобы работало `npx tsx tools/set-generator ...` из корня репозитория.
import { main } from './src/cli.ts';

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
