import Database from 'better-sqlite3';
import { describe, expect, test } from 'vitest';
import { migrateProjectMembers, readMembers } from '../../server/src/modules/settings/store.js';

describe('project member schema migration', () => {
  test('migrates reviewer memberships without changing identifiers, capacity foreign keys or task review history and repeats safely', () => {
    const db = new Database(':memory:');
    try {
      db.pragma('foreign_keys = ON');
      db.exec(`CREATE TABLE settings_projects(project_id TEXT PRIMARY KEY);
        INSERT INTO settings_projects VALUES('legacy');
        CREATE TABLE project_members(project_id TEXT NOT NULL REFERENCES settings_projects(project_id),id TEXT NOT NULL,name TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('manager','member','reviewer','viewer')),active INTEGER NOT NULL CHECK(active IN(0,1)),PRIMARY KEY(project_id,id),UNIQUE(project_id,name));
        INSERT INTO project_members VALUES('legacy','old-reviewer','旧验收人','reviewer',1);
        INSERT INTO project_members VALUES('legacy','owner','原负责人','manager',1);
        CREATE TABLE member_capacities(project_id TEXT NOT NULL,member_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,FOREIGN KEY(project_id,member_id) REFERENCES project_members(project_id,id));
        INSERT INTO member_capacities VALUES('legacy','old-reviewer','{"hoursPerDay":6}');
        CREATE TABLE task_meta(task_id TEXT PRIMARY KEY, meta_json TEXT NOT NULL);
        INSERT INTO task_meta VALUES('task','{"reviewerId":"old-reviewer","submissions":[{"reviewerId":"old-reviewer","comment":"历史验收"}]}');`);
      const history = db.prepare('SELECT * FROM task_meta').all(); const capacity = db.prepare('SELECT * FROM member_capacities').all();
      migrateProjectMembers(db); migrateProjectMembers(db);
      expect(readMembers(db, 'legacy')).toEqual([{ id: 'old-reviewer', name: '旧验收人', role: 'member', active: true, removedAt: null }, { id: 'owner', name: '原负责人', role: 'manager', active: true, removedAt: null }]);
      expect(db.prepare('SELECT * FROM task_meta').all()).toEqual(history);
      expect(db.prepare('SELECT * FROM member_capacities').all()).toEqual(capacity);
      expect(db.pragma('foreign_key_check')).toEqual([]); expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(() => db.prepare("UPDATE project_members SET role='project_admin' WHERE id='old-reviewer'").run()).not.toThrow();
      expect(() => db.prepare("UPDATE project_members SET role='reviewer' WHERE id='old-reviewer'").run()).toThrow();
      expect(() => db.prepare("DELETE FROM project_members WHERE id='old-reviewer'").run()).toThrow();
    } finally { db.close(); }
  });
});
