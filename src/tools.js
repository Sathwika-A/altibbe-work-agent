// tools.js
// Real, callable functions the agent can invoke. Each tool returns
// { ok: true, data: {...} } on success or { ok: false, error: '...' } on
// failure. Tools never throw for "expected" failure modes (bad URL, unreachable
// host, etc.) -- they report failure explicitly so the pipeline can log it
// honestly instead of pretending everything worked.

const fs = require('fs');
const path = require('path');
const { db, nowISO, log } = require('./db');

const BRIEFS_DIR = path.join(__dirname, '..', 'data', 'briefs');
if (!fs.existsSync(BRIEFS_DIR)) fs.mkdirSync(BRIEFS_DIR, { recursive: true });

// 1. Draft a communication (never sends anything externally).
function draftCommunication({ recipient, subject_or_topic, context }) {
  if (!subject_or_topic) {
    return { ok: false, error: 'Cannot draft communication: no subject/topic provided.' };
  }
  const to = recipient && recipient.trim() ? recipient : '[recipient not specified]';
  const subject = `Re: ${subject_or_topic}`;
  const body =
`Hi ${to === '[recipient not specified]' ? 'there' : to},

Thank you for taking the time to discuss ${subject_or_topic}. ${context ? context : ''}

I'll follow up with next steps shortly. Please let me know if I've missed anything.

Best regards`;
  return {
    ok: true,
    data: { to, subject, body, drafted_at: nowISO(), note: 'DRAFT ONLY -- not sent. Requires human approval before use.' }
  };
}

// 2. Create a task record in persistent storage (separate lightweight table
// reused from `actions`, but exposed here as an explicit "create a record" tool
// for cases where the plan wants a standalone task, e.g. from an action item).
function createTaskRecord({ requestId, description, owner, dueHint }) {
  if (!description) {
    return { ok: false, error: 'Cannot create task record: missing description.' };
  }
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`
    CREATE TABLE IF NOT EXISTS task_records (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      description TEXT NOT NULL,
      owner TEXT,
      due_hint TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
  db.prepare(`INSERT INTO task_records (id, request_id, description, owner, due_hint, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, requestId, description, owner || 'unassigned', dueHint || '', nowISO());
  return { ok: true, data: { task_record_id: id, description, owner: owner || 'unassigned' } };
}

// 3. Generate a markdown brief, written to disk.
function generateMarkdownBrief({ requestId, title, structured }) {
  if (!structured) {
    return { ok: false, error: 'Cannot generate brief: no structured data provided.' };
  }
  const fileName = `${requestId}.md`;
  const filePath = path.join(BRIEFS_DIR, fileName);
  const md = `# ${title || 'Untitled Brief'}

**Generated:** ${nowISO()}
**Priority:** ${structured.priority || 'unspecified'}
**Deadline:** ${structured.detected_deadline || 'none detected'}

## Summary
${structured.summary || 'n/a'}

## Action Items
${(structured.action_items || []).map((a, i) => `${i + 1}. ${a.description}${a.owner_hint ? ` (owner: ${a.owner_hint})` : ''}`).join('\n') || 'none'}

## Missing Information
${(structured.missing_information || []).map(m => `- ${m}`).join('\n') || 'none noted'}

## Could Be Automated
${(structured.could_be_automated || []).map(m => `- ${m}`).join('\n') || 'none noted'}
`;
  try {
    fs.writeFileSync(filePath, md, 'utf8');
  } catch (err) {
    return { ok: false, error: `Failed to write brief to disk: ${err.message}` };
  }
  return { ok: true, data: { file_path: filePath, markdown: md } };
}

// 4. Run a bounded, read-only website check. This is the tool used for
// "review hedamo.com" -- it only does what it can actually verify.
async function runWebsiteCheck({ url }) {
  if (!url) return { ok: false, error: 'Cannot run website check: no URL provided.' };
  let target = url.trim();
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;

  const startedAt = Date.now();
  try {
    const res = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'unstructured-work-agent-bounded-check/1.0' }
    });
    const elapsedMs = Date.now() - startedAt;
    const html = await res.text();
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    return {
      ok: true,
      data: {
        url: target,
        http_status: res.status,
        response_time_ms: elapsedMs,
        page_title: titleMatch ? titleMatch[1].trim() : null,
        has_meta_description: !!descMatch,
        meta_description: descMatch ? descMatch[1].trim() : null,
        html_size_bytes: Buffer.byteLength(html, 'utf8'),
        checked_at: nowISO(),
        checks_performed: ['http_status', 'response_time', 'title_tag', 'meta_description_presence', 'html_size'],
        checks_not_performed: ['SEO scoring', 'accessibility audit', 'security scan', 'performance/Lighthouse audit', 'broken-link crawl']
      }
    };
  } catch (err) {
    // Explicit, honest failure -- this is the required "sensible failure path".
    return {
      ok: false,
      error: `Website check failed for ${target}: ${err.name === 'TimeoutError' ? 'request timed out after 8s' : err.message}`
    };
  }
}

// 5. Simulate a reminder (no real calendar integration).
function simulateReminder({ requestId, daysFromNow, note }) {
  const days = Number.isFinite(daysFromNow) ? daysFromNow : 7;
  const due = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  db.prepare(`
    CREATE TABLE IF NOT EXISTS simulated_reminders (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      note TEXT,
      due_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  const id = `rem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(`INSERT INTO simulated_reminders (id, request_id, note, due_at, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, requestId, note || '', due.toISOString(), nowISO());
  return { ok: true, data: { reminder_id: id, due_at: due.toISOString(), note: note || '', simulated: true } };
}

// 6. Search stored work (previous requests) by keyword.
function searchStoredWork({ query }) {
  if (!query) return { ok: false, error: 'Cannot search: no query provided.' };
  const rows = db.prepare(
    `SELECT id, original_text, structured_json, status, created_at FROM requests
     WHERE original_text LIKE ? OR structured_json LIKE ?
     ORDER BY created_at DESC LIMIT 10`
  ).all(`%${query}%`, `%${query}%`);
  return { ok: true, data: { matches: rows.map(r => ({ id: r.id, status: r.status, created_at: r.created_at, preview: r.original_text.slice(0, 140) })) } };
}

const TOOLS = {
  draft_communication: draftCommunication,
  create_task_record: createTaskRecord,
  generate_markdown_brief: generateMarkdownBrief,
  run_website_check: runWebsiteCheck,
  simulate_reminder: simulateReminder,
  search_stored_work: searchStoredWork
};

module.exports = { TOOLS };
