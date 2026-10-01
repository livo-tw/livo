// @vitest-environment node
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { TABLES } from '../../worker/src/tables';
import { rowToWire, valueToDb } from '../../worker/src/meta';

const schema = readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8');
const alter = readFileSync(new URL('../../worker/migrate/member-manual-alters.sql', import.meta.url), 'utf8');

describe('manual answer schema compatibility', () => {
  it('upgrades existing answers without changing legacy text and skips a repeated upgrade', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec("CREATE TABLE member_manuals (id TEXT PRIMARY KEY, best_state TEXT); INSERT INTO member_manuals VALUES ('old','Existing answer')");
      const migrate = () => {
        const columns = db.prepare('PRAGMA table_info(member_manuals)').all();
        if (!columns.some(column => column.name === 'custom_fields')) db.exec(alter);
      };
      migrate(); migrate();
      expect(db.prepare('SELECT * FROM member_manuals').get()).toMatchObject({ best_state: 'Existing answer', custom_fields: '{}' });
      db.prepare('UPDATE member_manuals SET custom_fields=? WHERE id=?').run('{"custom_example":"Saved answer"}', 'old');
      expect(() => db.prepare('UPDATE member_manuals SET custom_fields=? WHERE id=?').run('[]', 'old')).toThrow();
      expect(rowToWire(db.prepare('SELECT * FROM member_manuals').get()!, TABLES.member_manuals))
        .toMatchObject({ custom_fields: { custom_example: 'Saved answer' } });
    } finally { db.close(); }
  });

  it('supports fresh installs, repeated schema application and JSON writes', () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec(schema); db.exec(schema);
      expect(db.prepare('PRAGMA table_info(member_manuals)').all().some(column => column.name === 'custom_fields')).toBe(true);
      expect(valueToDb('custom_fields', { custom_example: 'Answer' }, TABLES.member_manuals)).toBe('{"custom_example":"Answer"}');
    } finally { db.close(); }
  });
});
