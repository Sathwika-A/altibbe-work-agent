// db.js
// SQLite persistence layer. Uses better-sqlite3 (synchronous, no callback hell,
// fine for a single-process prototype like this one).

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'agent.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  original_text TEXT NOT NULL,
  structured_json TEXT,        -- LLM extraction output (schema in llm.js)
  plan_json TEXT,               -- agentic plan output
  status TEXT NOT NULL DEFAULT 'received',
    -- received -> interpreted -> planned -> awaiting_approval -> completed
    --                                                          -> failed
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,             -- order within the plan
  description TEXT NOT NULL,
  route TEXT NOT NULL,              -- execute_auto | human_review | cannot_execute | needs_clarification
  reason TEXT NOT NULL,
  tool_name TEXT,                   -- which tool (if any) handles this action
  tool_input_json TEXT,
  tool_output_json TEXT,
  approval_status TEXT NOT NULL DEFAULT 'n/a',
    -- n/a (no approval needed) | pending | approved | rejected | edited
  final_output_json TEXT,           -- output after human approval/edit, if applicable
  error TEXT,                       -- populated on failure
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  actor TEXT NOT NULL,     -- system | llm | tool | user
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`);

function nowISO() {
  return new Date().toISOString();
}

function log(requestId, actor, message) {
  db.prepare(
    `INSERT INTO activity_log (request_id, actor, message, created_at) VALUES (?, ?, ?, ?)`
  ).run(requestId, actor, message, nowISO());
}

module.exports = { db, nowISO, log };

// Allow `npm run init-db` to just create the file/schema and exit.
if (require.main === module) {
  console.log(`SQLite database initialized at ${DB_PATH}`);
}
