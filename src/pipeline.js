// pipeline.js
// Orchestrates the multi-step agent flow, passing state (the request id,
// the structured interpretation, the plan) between steps and persisting
// after each one. This is intentionally NOT a framework -- it's a plain
// sequence of async functions so every step is easy to read and explain.

const { v4: uuidv4 } = require('uuid');
const { db, nowISO, log } = require('./db');
const llm = require('./llm');
const { TOOLS } = require('./tools');

function saveRequest(id, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  db.prepare(`UPDATE requests SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowISO(), id);
}

function insertAction(requestId, seq, planItem) {
  const id = uuidv4();
  // Anything not execute_auto needs a human touchpoint before being "done".
  // We specifically require explicit approval for human_review actions --
  // that is the mandatory Approve/Reject/Edit gate the assignment requires.
  const approvalStatus = planItem.route === 'human_review' ? 'pending' : 'n/a';
  db.prepare(`
    INSERT INTO actions (id, request_id, seq, description, route, reason, tool_name, tool_input_json, approval_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, requestId, seq, planItem.action_description, planItem.route, planItem.reason,
    planItem.tool_name || 'none', JSON.stringify(planItem.tool_input || {}), approvalStatus,
    nowISO(), nowISO()
  );
  return id;
}

function updateAction(actionId, fields) {
  const sets = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const values = Object.values(fields);
  db.prepare(`UPDATE actions SET ${sets}, updated_at = ? WHERE id = ?`).run(...values, nowISO(), actionId);
}

/**
 * Computes the correct request-level status from the actual state of its
 * actions. This is the single source of truth for status -- both the initial
 * pipeline run and resolveAction() call this instead of each hand-rolling
 * their own (previously inconsistent) logic.
 *
 * Rules:
 *  - Any human_review action still 'pending'          -> awaiting_approval
 *  - No actions blocked, everything auto/approved      -> completed
 *  - Some actions blocked (needs_clarification /
 *    cannot_execute / a failed tool call), but at least
 *    one action genuinely executed or was approved     -> completed_with_gaps
 *  - Every single action is blocked (nothing executed
 *    and nothing approved at all)                       -> blocked_needs_clarification
 */
function computeFinalStatus(requestId) {
  const actions = db.prepare('SELECT * FROM actions WHERE request_id = ?').all(requestId);
  if (actions.length === 0) return 'completed'; // no actions in the plan at all -- nothing to block on

  const anyPendingApproval = actions.some(a => a.approval_status === 'pending');
  if (anyPendingApproval) return 'awaiting_approval';

  const isBlocked = (a) =>
    a.route === 'needs_clarification' ||
    a.route === 'cannot_execute' ||
    !!a.error; // an execute_auto or human_review action whose tool call failed

  const isResolvedWork = (a) =>
    (a.route === 'execute_auto' && !a.error) ||
    (a.route === 'human_review' && ['approved', 'edited'].includes(a.approval_status));

  const anyBlocked = actions.some(isBlocked);
  const anyResolvedWork = actions.some(isResolvedWork);

  if (!anyBlocked) return 'completed';
  if (anyBlocked && anyResolvedWork) return 'completed_with_gaps';
  return 'blocked_needs_clarification';
}

async function runToolForAction(requestId, action) {
  const toolFn = TOOLS[action.tool_name];
  if (!toolFn || action.tool_name === 'none') {
    return { ok: false, error: `No tool bound to this action (tool_name="${action.tool_name}").` };
  }
  const input = JSON.parse(action.tool_input_json || '{}');
  // Normalize/augment tool input with request context each tool actually needs.
  const augmented = {
    ...input,
    requestId,
    recipient: input.recipient,
    subject_or_topic: input.subject_or_topic,
    context: input.note,
    description: input.subject_or_topic || action.description,
    owner: input.recipient,
    dueHint: input.note,
    daysFromNow: input.days_from_now,
    note: input.note,
    url: input.url,
    query: input.query
  };
  try {
    const result = await toolFn(augmented);
    return result;
  } catch (err) {
    // A tool throwing unexpectedly is itself a failure path we must not hide.
    return { ok: false, error: `Tool "${action.tool_name}" threw an unexpected error: ${err.message}` };
  }
}

/**
 * Full pipeline for a freshly-submitted piece of unstructured text.
 * State passed between steps: requestId -> interpretation -> plan -> actions.
 */
async function processNewRequest(rawText) {
  const requestId = uuidv4();
  const ts = nowISO();
  db.prepare(`INSERT INTO requests (id, original_text, status, created_at, updated_at) VALUES (?, ?, 'received', ?, ?)`)
    .run(requestId, rawText, ts, ts);
  log(requestId, 'system', 'Request received via intake endpoint.');

  // ---- Step 1: Interpretation ----
  let interpretation;
  try {
    log(requestId, 'llm', `Calling ${llm.GEMINI_MODEL} to extract structured interpretation...`);
    interpretation = await llm.interpret(rawText);
    saveRequest(requestId, { structured_json: JSON.stringify(interpretation), status: 'interpreted' });
    log(requestId, 'llm', `Interpretation complete: "${interpretation.task_title}" (priority: ${interpretation.priority}).`);
  } catch (err) {
    saveRequest(requestId, { status: 'failed' });
    log(requestId, 'system', `FAILED at interpretation step: ${err.message}`);
    return { requestId, status: 'failed', stage: 'interpretation', error: err.message };
  }

  // ---- Step 2: Agentic planning ----
  let planItems;
  try {
    log(requestId, 'llm', `Calling ${llm.GEMINI_MODEL} to generate execution plan...`);
    planItems = await llm.plan(interpretation);
    saveRequest(requestId, { plan_json: JSON.stringify(planItems), status: 'planned' });
    log(requestId, 'llm', `Plan generated with ${planItems.length} action(s).`);
  } catch (err) {
    saveRequest(requestId, { status: 'failed' });
    log(requestId, 'system', `FAILED at planning step: ${err.message}`);
    return { requestId, status: 'failed', stage: 'planning', error: err.message };
  }

  // ---- Step 3: Execute plan (route-aware) ----
  let seq = 0;
  for (const item of planItems) {
    seq += 1;
    const actionId = insertAction(requestId, seq, item);
    log(requestId, 'system', `Action ${seq} routed as "${item.route}": ${item.action_description} -- ${item.reason}`);

    if (item.route === 'execute_auto') {
      log(requestId, 'tool', `Executing tool "${item.tool_name}" automatically for action ${seq}.`);
      // Inject request-relevant context the plan didn't have (e.g. structured data for briefs).
      const inputForTool = JSON.parse(JSON.stringify(item.tool_input || {}));
      if (item.tool_name === 'generate_markdown_brief') {
        inputForTool.structured = interpretation;
        inputForTool.title = interpretation.task_title;
      }
      const actionRow = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
      actionRow.tool_input_json = JSON.stringify(inputForTool);
      const result = await runToolForAction(requestId, actionRow);
      if (result.ok) {
        updateAction(actionId, { tool_output_json: JSON.stringify(result.data), final_output_json: JSON.stringify(result.data) });
        log(requestId, 'tool', `Tool "${item.tool_name}" succeeded for action ${seq}.`);
      } else {
        updateAction(actionId, { error: result.error });
        log(requestId, 'tool', `Tool "${item.tool_name}" FAILED for action ${seq}: ${result.error}`);
      }
    } else if (item.route === 'human_review') {
      // Prepare output via the tool, but do NOT treat it as complete.
      log(requestId, 'tool', `Preparing draft output via "${item.tool_name}" for human review (action ${seq}).`);
      const actionRow = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
      const result = await runToolForAction(requestId, actionRow);
      if (result.ok) {
        updateAction(actionId, { tool_output_json: JSON.stringify(result.data) });
        log(requestId, 'tool', `Draft prepared for action ${seq}. Awaiting human approve/reject/edit.`);
      } else {
        updateAction(actionId, { error: result.error, approval_status: 'n/a' });
        log(requestId, 'tool', `Could not prepare draft for action ${seq}: ${result.error}`);
      }
    } else if (item.route === 'cannot_execute') {
      log(requestId, 'system', `Action ${seq} cannot be executed with available tools: ${item.reason}`);
    } else if (item.route === 'needs_clarification') {
      log(requestId, 'system', `Action ${seq} needs clarification before it can proceed: ${item.reason}`);
    }
  }

  const finalStatus = computeFinalStatus(requestId);
  saveRequest(requestId, { status: finalStatus });
  log(requestId, 'system', `Pipeline finished. Status: ${finalStatus}.`);

  return { requestId, status: finalStatus };
}

/**
 * Human-in-the-loop gate: approve, reject, or edit a human_review action.
 */
function resolveAction(actionId, decision, editedOutput) {
  const action = db.prepare('SELECT * FROM actions WHERE id = ?').get(actionId);
  if (!action) return { ok: false, error: 'Action not found.' };
  if (action.route !== 'human_review') {
    return { ok: false, error: `Action route is "${action.route}", not "human_review" -- nothing to approve.` };
  }
  if (action.approval_status !== 'pending') {
    return { ok: false, error: `Action already resolved (status: ${action.approval_status}).` };
  }

  if (!['approve', 'reject', 'edit'].includes(decision)) {
    return { ok: false, error: `Invalid decision "${decision}". Must be approve, reject, or edit.` };
  }

  const requestId = action.request_id;
  if (decision === 'approve') {
    updateAction(actionId, { approval_status: 'approved', final_output_json: action.tool_output_json });
    log(requestId, 'user', `Action ${action.seq} approved as-is.`);
  } else if (decision === 'reject') {
    updateAction(actionId, { approval_status: 'rejected', final_output_json: null });
    log(requestId, 'user', `Action ${action.seq} rejected.`);
  } else if (decision === 'edit') {
    if (!editedOutput) return { ok: false, error: 'Edit decision requires editedOutput.' };
    updateAction(actionId, { approval_status: 'edited', final_output_json: JSON.stringify(editedOutput) });
    log(requestId, 'user', `Action ${action.seq} edited and approved by human.`);
  }

  // Recompute the parent request's status from actual action state once this
  // approval is resolved -- reuses the same logic as the initial pipeline run
  // so both paths agree (previously this always hardcoded 'completed', which
  // was wrong whenever needs_clarification/cannot_execute actions existed
  // alongside the approved one).
  const newStatus = computeFinalStatus(requestId);
  if (newStatus !== 'awaiting_approval') {
    saveRequest(requestId, { status: newStatus });
    log(requestId, 'system', `All pending approvals resolved. Request status: ${newStatus}.`);
  }

  return { ok: true };
}

module.exports = { processNewRequest, resolveAction, computeFinalStatus };