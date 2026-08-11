// server.js
require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { db } = require('./db');
const pipeline = require('./pipeline');
const { TOOLS } = require('./tools');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Intake: submit unstructured text, runs the full pipeline synchronously ----
app.post('/api/requests', async (req, res) => {
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Request body must include non-empty "text".' });
  }
  if (text.length > 20000) {
    return res.status(400).json({ error: 'Text too long (max 20000 characters).' });
  }
  try {
    const result = await pipeline.processNewRequest(text.trim());
    const status = result.status === 'failed' ? 502 : 201;
    res.status(status).json(result);
  } catch (err) {
    // Should be rare -- pipeline.processNewRequest catches its own known
    // failure points. This is the outer safety net.
    res.status(500).json({ error: `Unexpected server error: ${err.message}` });
  }
});

// ---- List all requests (summary) ----
app.get('/api/requests', (req, res) => {
  const rows = db.prepare(
    `SELECT id, original_text, status, structured_json, created_at, updated_at FROM requests ORDER BY created_at DESC`
  ).all();
  const summarized = rows.map(r => ({
    id: r.id,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
    title: safeParse(r.structured_json)?.task_title || '(not yet interpreted)',
    preview: r.original_text.slice(0, 120)
  }));
  res.json(summarized);
});

// ---- Full detail for one request: interpretation, plan, actions, trace ----
app.get('/api/requests/:id', (req, res) => {
  const request = db.prepare(`SELECT * FROM requests WHERE id = ?`).get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });

  const actions = db.prepare(`SELECT * FROM actions WHERE request_id = ? ORDER BY seq ASC`).all(req.params.id);
  const trace = db.prepare(`SELECT * FROM activity_log WHERE request_id = ? ORDER BY id ASC`).all(req.params.id);

  res.json({
    id: request.id,
    original_text: request.original_text,
    status: request.status,
    created_at: request.created_at,
    updated_at: request.updated_at,
    interpretation: safeParse(request.structured_json),
    plan: safeParse(request.plan_json),
    actions: actions.map(a => ({
      id: a.id,
      seq: a.seq,
      description: a.description,
      route: a.route,
      reason: a.reason,
      tool_name: a.tool_name,
      tool_input: safeParse(a.tool_input_json),
      tool_output: safeParse(a.tool_output_json),
      approval_status: a.approval_status,
      final_output: safeParse(a.final_output_json),
      error: a.error
    })),
    trace: trace.map(t => ({ actor: t.actor, message: t.message, at: t.created_at }))
  });
});

// ---- Human-in-the-loop: approve / reject / edit a pending action ----
app.post('/api/actions/:id/resolve', (req, res) => {
  const { decision, editedOutput } = req.body || {};
  const result = pipeline.resolveAction(req.params.id, decision, editedOutput);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ ok: true });
});

// ---- Direct tool invocation endpoint (used for manual testing / search tool) ----
app.post('/api/tools/search_stored_work', (req, res) => {
  const { query } = req.body || {};
  const result = TOOLS.search_stored_work({ query });
  res.json(result);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', has_key: !!process.env.GEMINI_API_KEY });
});

function safeParse(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch (_) { return null; }
}

app.listen(PORT, () => {
  console.log(`Agent app listening on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('WARNING: GEMINI_API_KEY is not set. Interpretation/planning calls will fail until you set it in .env.');
  }
});
