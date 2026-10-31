import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("local launcher safety profile", () => {
  it("prepares the complete local schema idempotently and refuses an unmanaged database", () => {
    const code = `
      import fs from 'node:fs';
      import path from 'node:path';
      import os from 'node:os';
      import assert from 'node:assert/strict';
      import { DatabaseSync } from 'node:sqlite';
      import { prepareLocalDatabase } from './tools/prepare-local.mjs';
      const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'artatrade-local-test-'));
      try {
        fs.cpSync('prisma/migrations', path.join(fixture, 'prisma/migrations'), { recursive: true });
        const target = await prepareLocalDatabase(fixture);
        const first = new DatabaseSync(target);
        const count = first.prepare('SELECT COUNT(*) AS n FROM _arta_local_migrations').get().n;
        assert(count > 10);
        first.prepare('SELECT id FROM Position LIMIT 1').all();
        first.prepare('SELECT id FROM Trade LIMIT 1').all();
        first.close();
        await prepareLocalDatabase(fixture);
        const second = new DatabaseSync(target);
        assert.equal(second.prepare('SELECT COUNT(*) AS n FROM _arta_local_migrations').get().n, count);
        second.exec('DROP TABLE _arta_local_migrations'); second.close();
        await assert.rejects(prepareLocalDatabase(fixture), /LOCAL_DATABASE_UNMANAGED/);
        const third = new DatabaseSync(target);
        third.prepare('SELECT id FROM Position LIMIT 1').all(); third.close();
        console.log(JSON.stringify({ idempotent: true, unmanagedRejected: true }));
      } finally {
        if (path.dirname(fixture) === os.tmpdir() && path.basename(fixture).startsWith('artatrade-local-test-')) fs.rmSync(fixture, { recursive: true });
      }
    `;
    const output = execFileSync(process.execPath, ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", code], { cwd: root, encoding: "utf8" });
    expect(JSON.parse(output)).toEqual({ idempotent: true, unmanagedRejected: true });
  });

  it("selects each lane without booting the application", () => {
    for (const mode of ["SCALP", "SWING", "BOTH"]) {
      const output = execFileSync(process.execPath, ["tools/start-local.mjs", `--mode=${mode}`, "--print-plan"], { cwd: root, encoding: "utf8" });
      expect(JSON.parse(output)).toEqual({ mode, profile: "local", script: `dev:${mode.toLowerCase()}` });
    }
  });

  it("the selected profile overrides inherited account settings without loading env files", () => {
    const code = `
      import { env, envProvenance } from './apps/server/src/core/env.ts';
      const status = {
        executionMode: env.BINANCE_EXECUTION_MODE,
        credentialsEmpty: !env.BINANCE_API_KEY && !env.BINANCE_API_SECRET && !env.XKIRO_API_KEY,
        armOff: process.env.ARM_DEFAULT === 'false',
        localDatabase: process.env.DATABASE_URL.replaceAll('\\\\', '/').endsWith('/data/local/artatrade.db'),
        databaseSource: envProvenance.DATABASE_URL,
      };
      console.log(JSON.stringify(status));
    `;
    const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: root, encoding: "utf8", env: { ...process.env, ARTA_ENV_PROFILE: "local", ARTA_OFFLINE_TEST: "false",
        BINANCE_EXECUTION_MODE: "LIVE", BINANCE_API_KEY: "fixture-only", BINANCE_API_SECRET: "fixture-only",
        XKIRO_API_KEY: "fixture-only", ARM_DEFAULT: "true", DATABASE_URL: "file:/unrelated/fixture.db" },
    });
    expect(JSON.parse(output)).toEqual({ executionMode: "PAPER", credentialsEmpty: true, armOff: true,
      localDatabase: true, databaseSource: "localProfile" });
  });
});
