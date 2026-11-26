import type Database from 'better-sqlite3';

type SchemaObject = { type: string; name: string; sql: string };
export interface SchemaContract { version: number; objects: SchemaObject[]; migrations: Record<string, number[]> }
// Preserve string literals; ignore SQL formatting and quoted identifier differences.
export function normalizeSql(sql: string) {
  const tokens = sql.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|\[[^\]]*\]|`[^`]*`|[^'"`\[\s]+/g) || [];
  const normalized: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.toLowerCase() === 'if' && tokens[i+1]?.toLowerCase() === 'not' && tokens[i+2]?.toLowerCase() === 'exists') { i += 2; continue; }
    normalized.push(token.startsWith("'") ? token : token.replace(/["`\[\]]/g, '').toLowerCase());
  }
  return normalized.join('').replace(/;$/, '');
}
export function readSchema(db: Database.Database): SchemaContract {
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as SchemaObject[];
  const migrations: Record<string, number[]> = {};
  for (const object of objects.filter(item => item.type === 'table' && item.name.endsWith('_schema_migrations'))) {
    migrations[object.name] = (db.prepare(`SELECT version FROM "${object.name}" ORDER BY version`).all() as {version:number}[]).map(row => row.version);
  }
  return { version: db.pragma('user_version', {simple:true}) as number, objects, migrations };
}
export function schemaDifferences(actual: SchemaContract, expected: SchemaContract): string[] {
  const differences: string[] = [];
  if (actual.version !== expected.version) differences.push(`user_version: 需要 ${expected.version}，当前 ${actual.version}`);
  for (const object of expected.objects) {
    const found = actual.objects.find(item => item.name === object.name && item.type === object.type);
    if (!found) differences.push(`缺少 ${object.type}: ${object.name}`);
    else if (normalizeSql(found.sql) !== normalizeSql(object.sql)) differences.push(`结构定义不匹配: ${object.name}`);
  }
  for (const [name, versions] of Object.entries(expected.migrations)) {
    if (JSON.stringify(actual.migrations[name]) !== JSON.stringify(versions)) differences.push(`版本记录不匹配: ${name}，需要 ${versions.join(',')}`);
  }
  return differences;
}
