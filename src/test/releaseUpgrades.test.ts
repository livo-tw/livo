// Database upgrades for existing self-host installs (scripts/release-upgrades.mjs):
// which migrations become upgrades, and the lint that keeps them safe to
// re-run on customer data. Also runs that lint over the real migrations, so a
// new non-idempotent migration fails `npm test` before it fails a release build.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BASELINE_MIGRATIONS,
  NO_TRANSACTION_MARKER,
  buildUpgradeFile,
  lintUpgradeMigration,
  makeIdempotent,
  splitTopLevelStatements,
  stripDemoSeeds,
  trackingSeedSql,
  upgradeMigrationNames,
} from '../../scripts/release-upgrades.mjs';

const MIGRATIONS = path.resolve(__dirname, '../../supabase/migrations');
const migFiles = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'));
// Seller-only migration, left out of the public (open-source) export.
const NOT_IN_PUBLIC_EXPORT = new Set(['20260331_create_orders.sql']);
const prepared = (f: string) => makeIdempotent(stripDemoSeeds(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8')));

describe('which migrations become upgrades', () => {
  it('every baseline migration still exists (the list is frozen, never renamed)', () => {
    for (const f of BASELINE_MIGRATIONS) {
      if (!NOT_IN_PUBLIC_EXPORT.has(f)) expect(migFiles).toContain(f);
    }
  });

  it('new migrations become upgrades whatever their date; baseline and excluded ones never do', () => {
    const names = upgradeMigrationNames(
      ['20260714_notify_dispatch.sql', '20261001_api_tokens.sql', '20250101_backdated.sql', '20261002_seller.sql'],
      new Map([['20261002_seller.sql', 'seller only']]),
    );
    expect(names).toEqual(['20250101_backdated.sql', '20261001_api_tokens.sql']);
  });

  it('includes the api_tokens migration', () => {
    expect(upgradeMigrationNames(migFiles, new Set())).toContain('20261001_api_tokens.sql');
  });

  it('every upgrade migration in the repo passes the lint', () => {
    for (const f of upgradeMigrationNames(migFiles, new Set())) {
      expect({ file: f, problems: lintUpgradeMigration(prepared(f)) }).toEqual({ file: f, problems: [] });
    }
  });
});

describe('splitTopLevelStatements', () => {
  it('ignores comments, strings and dollar-quoted bodies', () => {
    const sql = `
      -- CREATE TABLE commented_out (id int);
      /* block; /* nested; */ still comment; */
      INSERT INTO t (a) VALUES ('semi;colon -- not a comment') ON CONFLICT DO NOTHING;
      DO $$ BEGIN CREATE TABLE inside_do (id int); END $$;
      CREATE OR REPLACE FUNCTION f() RETURNS int LANGUAGE sql AS $body$ SELECT 1; $body$;
      SELECT $1;
    `;
    const stmts = splitTopLevelStatements(sql).map((s) => s.text);
    expect(stmts).toHaveLength(4);
    expect(stmts[0]).toMatch(/^INSERT INTO t/);
    expect(stmts.join(' ')).not.toMatch(/commented_out|inside_do|semi;colon/);
  });
});

describe('lintUpgradeMigration', () => {
  const lint = (sql: string) => lintUpgradeMigration(makeIdempotent(sql));
  const ok = [
    'CREATE TABLE IF NOT EXISTS public.x (id uuid PRIMARY KEY);',
    'CREATE UNIQUE INDEX IF NOT EXISTS x_idx ON public.x (id);',
    'ALTER TABLE public.x ADD COLUMN IF NOT EXISTS note text, ADD COLUMN IF NOT EXISTS n int DEFAULT 0;',
    'ALTER TABLE public.x DROP CONSTRAINT IF EXISTS x_chk, ADD CONSTRAINT x_chk CHECK (n >= 0);',
    'ALTER TABLE public.x ALTER COLUMN n DROP DEFAULT;',
    'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;',
    'DROP TRIGGER IF EXISTS trg ON public.x; CREATE TRIGGER trg AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION public.f();',
    'CREATE POLICY "read x" ON public.x FOR SELECT USING (true);',
    "INSERT INTO public.x (id) VALUES ('a') ON CONFLICT (id) DO NOTHING;",
    "UPDATE public.x SET note = '' WHERE note IS NULL;",
    'DO $$ BEGIN CREATE TYPE public.kind AS ENUM (\'a\'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;',
    'ALTER TABLE public.x ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public.x FROM anon;',
    'ALTER PUBLICATION supabase_realtime ADD TABLE public.x;',
    `${NO_TRANSACTION_MARKER}\nALTER TYPE public.kind ADD VALUE IF NOT EXISTS 'b';`,
  ];
  it.each(ok)('accepts %s', (sql) => {
    expect(lint(sql)).toEqual([]);
  });

  const bad: [string, RegExp][] = [
    ['CREATE TABLE public.x (id int);', /IF NOT EXISTS/],
    ['CREATE INDEX x_idx ON public.x (id);', /IF NOT EXISTS/],
    ['ALTER TABLE public.x ADD COLUMN note text;', /ADD COLUMN/],
    ['ALTER TABLE public.x ADD note text;', /ADD COLUMN/],
    ['ALTER TABLE public.x ADD CONSTRAINT x_chk CHECK (true);', /DROP CONSTRAINT IF EXISTS/],
    ['ALTER TABLE public.x ADD UNIQUE (note);', /具名約束/],
    ['ALTER TABLE public.x RENAME COLUMN a TO b;', /RENAME/],
    ['CREATE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;', /OR REPLACE/],
    ['CREATE TRIGGER trg AFTER INSERT ON public.x FOR EACH ROW EXECUTE FUNCTION public.f();', /DROP TRIGGER IF EXISTS/],
    ['CREATE POLICY read_x ON public.x FOR SELECT USING (true);', /DROP POLICY IF EXISTS/],
    ["CREATE TYPE public.kind AS ENUM ('a');", /DO \$\$/],
    ["INSERT INTO public.x (id) VALUES ('a');", /ON CONFLICT/],
    ["ALTER TYPE public.kind ADD VALUE 'b';", /IF NOT EXISTS/],
    ["ALTER TYPE public.kind ADD VALUE IF NOT EXISTS 'b';", /no-transaction/],
    ['CREATE INDEX CONCURRENTLY IF NOT EXISTS x_idx ON public.x (id);', /no-transaction/],
    ['BEGIN; CREATE TABLE IF NOT EXISTS public.x (id int); COMMIT;', /BEGIN/],
    ['DROP TABLE IF EXISTS public.old_stuff;', /刪除資料表/],
    ['ALTER TABLE public.x DROP COLUMN note;', /DROP COLUMN/],
    ['ALTER TABLE public.x DROP note;', /DROP COLUMN/],
    ['DELETE FROM public.x;', /刪除資料/],
    ['TRUNCATE public.x;', /刪除資料/],
    ["UPDATE public.members SET auth_id = NULL;", /WHERE/],
    ['DROP FUNCTION IF EXISTS public.f() CASCADE;', /CASCADE/],
  ];
  it.each(bad)('rejects %s', (sql, why) => {
    const problems = lint(sql);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(why);
  });

  it('flags most of the early, non-idempotent migrations (why they stay out of upgrades)', () => {
    const flagged = [...BASELINE_MIGRATIONS]
      .filter((f) => migFiles.includes(f))
      .filter((f) => lintUpgradeMigration(prepared(f)).length > 0);
    expect(flagged).toContain('20260308173019_ad17e08d-5ca0-4d6d-b511-815ac2c1889f.sql');
    expect(flagged).toContain('20260404_clear_stale_auth_ids.sql');
    expect(flagged.length).toBeGreaterThan(15);
  });
});

describe('generated SQL', () => {
  it('wraps an upgrade in one transaction and records it', () => {
    const file = buildUpgradeFile('20261001_api_tokens.sql', 'CREATE TABLE IF NOT EXISTS public.x (id int);');
    const begin = file.indexOf('BEGIN;');
    const create = file.indexOf('CREATE TABLE IF NOT EXISTS public.x');
    const record = file.indexOf("INSERT INTO public.livo_schema_migrations (name) VALUES ('20261001_api_tokens.sql') ON CONFLICT (name) DO NOTHING;");
    const commit = file.indexOf('COMMIT;');
    expect(begin).toBeGreaterThan(-1);
    expect(begin < create && create < record && record < commit).toBe(true);
    expect(file).toContain('CREATE TABLE IF NOT EXISTS public.livo_schema_migrations');
  });

  it('leaves the transaction out when the migration asks for it', () => {
    const file = buildUpgradeFile('20261003_enum.sql', `${NO_TRANSACTION_MARKER}\nALTER TYPE public.kind ADD VALUE IF NOT EXISTS 'b';`);
    expect(file).not.toMatch(/^BEGIN;$/m);
    expect(file).not.toMatch(/^COMMIT;$/m);
    expect(file).toContain("VALUES ('20261003_enum.sql')");
  });

  it('records the migrations a fresh install already contains', () => {
    const sql = trackingSeedSql(['a.sql', 'b.sql']);
    expect(sql).toContain("('a.sql'),\n  ('b.sql')");
    expect(sql).toContain('ON CONFLICT (name) DO NOTHING;');
    expect(sql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(() => trackingSeedSql(["x'; DROP TABLE y; --.sql"])).toThrow();
    expect(() => buildUpgradeFile('bad name.sql', 'SELECT 1;')).toThrow();
  });
});
