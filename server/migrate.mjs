// Apply server/schema.sql to the Neon database in DATABASE_URL.
//   node migrate.mjs            (reads DATABASE_URL from env or .env.local)
import { readFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

if (!process.env.DATABASE_URL && existsSync('.env.local')) {
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^DATABASE_URL="?([^"]*)"?$/);
    if (m) process.env.DATABASE_URL = m[1];
  }
}
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL not set');

const sql = neon(process.env.DATABASE_URL);
const schema = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
// Split on statement boundaries, keeping $$ function bodies intact.
const statements = [];
let buf = '';
let inBody = false;
for (const line of schema.split('\n')) {
  if (/^\s*--/.test(line) && !inBody) continue;
  buf += `${line}\n`;
  if ((line.match(/\$\$/g) || []).length % 2 === 1) inBody = !inBody;
  if (!inBody && line.trim().endsWith(';')) {
    statements.push(buf.trim());
    buf = '';
  }
}
for (const s of statements) await sql.query(s);
const tables = await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`;
console.log(`applied ${statements.length} statements; tables: ${tables.map((t) => t.table_name).join(', ')}`);
