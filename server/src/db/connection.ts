import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { checkExistingDatabase, validateExistingDatabase } from './existing.js';
import { markExistingDatabase, type DatabaseMode } from './lifecycle.js';
import { demoSnapshot } from './demo-data.js';

export const defaultDatabasePath = fileURLToPath(new URL('../../../data/homepage-demo.sqlite', import.meta.url));

/** A dedicated preview database; no workbook imports or production schema are used. */
export function openHomepageDatabase(dbPath = defaultDatabasePath, mode: DatabaseMode = 'initialize') {
  if (mode === 'existing-only') {
    checkExistingDatabase(dbPath);
    const database = new Database(dbPath, {fileMustExist:true});
    try {
      validateExistingDatabase(database);
      database.pragma('foreign_keys = ON');
      database.pragma('busy_timeout = 5000');
      markExistingDatabase(database);
      return database;
    } catch (error) { database.close(); throw error; }
  }
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const database = new Database(dbPath);
  try {
    database.pragma('journal_mode = WAL');
    database.pragma('foreign_keys = ON');
    database.pragma('busy_timeout = 5000');
    const version = database.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw new Error('Unsupported homepage demo database version');
    database.transaction(() => {
      database.exec(`
        CREATE TABLE IF NOT EXISTS homepage_projects (
          id TEXT PRIMARY KEY,
          snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
        );
        CREATE TABLE IF NOT EXISTS homepage_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES homepage_projects(id),
          title TEXT NOT NULL,
          workstream_id TEXT NOT NULL,
          owner TEXT NOT NULL,
          initials TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('todo', 'in_progress', 'done')),
          priority TEXT NOT NULL CHECK(priority IN ('P0', 'P1', 'P2')),
          due TEXT NOT NULL,
          progress INTEGER NOT NULL CHECK(progress BETWEEN 0 AND 100),
          blocked INTEGER NOT NULL CHECK(blocked IN (0, 1)),
          position INTEGER NOT NULL,
          CHECK((status = 'done' AND progress = 100) OR (status != 'done' AND progress < 100))
        );
        CREATE INDEX IF NOT EXISTS homepage_tasks_project_status_due
          ON homepage_tasks(project_id, status, due);
        PRAGMA user_version = 1;
      `);
      const exists = database.prepare('SELECT id FROM homepage_projects WHERE id = ?').get(demoSnapshot.project.id);
      if (exists) return;
      const { tasks, ...snapshot } = demoSnapshot;
      database.prepare('INSERT INTO homepage_projects (id, snapshot_json) VALUES (?, ?)').run(snapshot.project.id, JSON.stringify(snapshot));
      const insertTask = database.prepare(`INSERT INTO homepage_tasks
        (id, project_id, title, workstream_id, owner, initials, status, priority, due, progress, blocked, position)
        VALUES (@id, @projectId, @title, @workstreamId, @owner, @initials, @status, @priority, @due, @progress, @blocked, @position)`);
      tasks.forEach((task, position) => insertTask.run({ ...task, projectId: snapshot.project.id, blocked: Number(task.blocked), position }));
    })();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
