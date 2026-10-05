// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

describe('deleting a product line (real SQLite schema)', () => {
  it('is refused while the line still has projects, including archived ones', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('ws-a','line-a','Line A'),('ws-a','line-empty','Empty');
      INSERT INTO projects(workspace_id,id,line_id,name,key,is_archived) VALUES('ws-a','project-a','line-a','A','A',1);`);
    expect(() => db.exec("DELETE FROM product_lines WHERE workspace_id='ws-a' AND id='line-a'")).toThrow('product_line_has_projects');
    expect(db.prepare("SELECT count(*) AS n FROM projects WHERE id='project-a'").get()?.n).toBe(1);
    db.exec("DELETE FROM product_lines WHERE workspace_id='ws-a' AND id='line-empty'");
    db.exec("DELETE FROM projects WHERE workspace_id='ws-a' AND id='project-a'");
    db.exec("DELETE FROM product_lines WHERE workspace_id='ws-a' AND id='line-a'");
    expect(db.prepare('SELECT count(*) AS n FROM product_lines').get()?.n).toBe(0);
    db.close();
  });
});
