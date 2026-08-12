// llm.js
// Thin wrapper around the Google Gemini API using structured (schema-constrained)
// JSON output. Two calls are made per request:
//   1. interpret()  -> extracts the fixed schema from raw text
//   2. plan()       -> turns extracted action items into a routed execution plan
//
// Both calls force responseMimeType: 'application/json' + a responseSchema,
// so the model cannot return free-form prose here -- this is what the
// assignment calls "structured output / JSON schema", not prompt-and-hope.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-latest';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

class LLMError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'LLMError';
    this.cause = cause;
  }
}

// ---- Schemas -----------------------------------------------------------

const INTERPRETATION_SCHEMA = {
  type: 'OBJECT',
  properties: {
    task_title: { type: 'STRING' },
    summary: { type: 'STRING' },
    action_items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING' },
          owner_hint: { type: 'STRING', description: 'Who seems responsible, or "unspecified"' }
        },
        required: ['description']
      }
    },
    priority: { type: 'STRING', enum: ['low', 'medium', 'high', 'urgent'] },
    detected_deadline: { type: 'STRING', description: 'ISO date or natural language deadline, or empty string if none' },
    missing_information: { type: 'ARRAY', items: { type: 'STRING' } },
    could_be_automated: { type: 'ARRAY', items: { type: 'STRING' } },
    requires_human_confirmation: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: [
    'task_title', 'summary', 'action_items', 'priority',
    'detected_deadline', 'missing_information',
    'could_be_automated', 'requires_human_confirmation'
  ]
};

const PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    plan: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          action_description: { type: 'STRING' },
          route: {
            type: 'STRING',
            enum: ['execute_auto', 'human_review', 'cannot_execute', 'needs_clarification']
          },
          reason: { type: 'STRING' },
          tool_name: {
            type: 'STRING',
            description: 'One of: draft_communication, create_task_record, generate_markdown_brief, run_website_check, simulate_reminder, search_stored_work, none',
            enum: ['draft_communication', 'create_task_record', 'generate_markdown_brief', 'run_website_check', 'simulate_reminder', 'search_stored_work', 'none']
          },
          tool_input: {
            type: 'OBJECT',
            properties: {
              recipient: { type: 'STRING' },
              subject_or_topic: { type: 'STRING' },
              url: { type: 'STRING' },
              days_from_now: { type: 'NUMBER' },
              note: { type: 'STRING' },
              query: { type: 'STRING' }
            }
          }
        },
        required: ['action_description', 'route', 'reason', 'tool_name']
      }
    }
  },
  required: ['plan']
};

// ---- Core call -----------------------------------------------------------

async function callGemini(systemInstruction, userText, schema) {
  if (!GEMINI_API_KEY) {
    throw new LLMError(
      'GEMINI_API_KEY is not set. Add it to your .env file (see .env.example). ' +
      'The Gemini API has a free tier with no credit card required: https://aistudio.google.com/apikey'
    );
  }

  const body = {
    system_instruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      temperature: 0.2
    }
  };

  let res;
  try {
    res = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000)
    });
  } catch (networkErr) {
    throw new LLMError(`Network error calling Gemini API: ${networkErr.message}`, networkErr);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch (_) { /* ignore */ }
    throw new LLMError(`Gemini API returned HTTP ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new LLMError('Gemini API response had no text content (possibly blocked by safety filters).');
  }

  try {
    return JSON.parse(text);
  } catch (parseErr) {
    // Validation: the model is instructed to return only JSON via responseSchema,
    // but we never trust that blindly -- if it's not parseable, we fail loudly
    // rather than pretending we got structured data.
    throw new LLMError(`Gemini API returned non-JSON output despite schema constraint: ${text.slice(0, 300)}`, parseErr);
  }
}

async function interpret(rawText) {
  const system = `You extract structured information from unstructured incoming work items
(emails, meeting notes, founder instructions, customer requests, bug reports).
Be precise and conservative: if information is not present in the text, do not invent it.
Put anything not explicitly stated (recipients, documents, dates, exact scope) into
"missing_information" rather than guessing. detected_deadline should be an empty string
if no deadline is mentioned anywhere in the text.`;

  const result = await interpretRaw(system, rawText);
  validateInterpretation(result);
  return result;
}

async function interpretRaw(system, rawText) {
  return callGemini(system, rawText, INTERPRETATION_SCHEMA);
}

function validateInterpretation(obj) {
  // Defensive validation beyond the schema (schema guarantees shape, not sense).
  if (!obj.task_title || typeof obj.task_title !== 'string') {
    throw new LLMError('Validation failed: interpretation missing a usable task_title.');
  }
  if (!Array.isArray(obj.action_items)) {
    throw new LLMError('Validation failed: action_items was not an array.');
  }
}

async function plan(interpretation) {
  const system = `You are an agentic planner. Given a structured interpretation of a work
request, decide how to route each action item using EXACTLY one of these routes:
- execute_auto: safe, low-risk, fully-specified actions a tool can do without a human
  (e.g. drafting a document for review, running a read-only website check, logging a
  reminder, creating an internal task record, searching prior stored work).
- human_review: the tool can prepare output, but a human must approve/reject/edit it
  before it is considered done (e.g. any communication addressed to another person).
- cannot_execute: no available tool can do this (available tools: draft_communication,
  create_task_record, generate_markdown_brief, run_website_check, simulate_reminder,
  search_stored_work).
- needs_clarification: required information is missing (e.g. unknown recipient, unknown
  document, unknown meeting time) -- do NOT invent details, route it here instead.
Available tools and what they do:
- draft_communication: drafts an email/message body (never sends it)
- create_task_record: stores a task record in the database
- generate_markdown_brief: generates a markdown summary document
- run_website_check: runs a bounded, read-only HTTP check against a URL (status code,
  response time, title tag, presence of meta description) -- nothing else
- simulate_reminder: schedules a simulated reminder N days from now (no real calendar)
- search_stored_work: searches previously stored requests by keyword
Give a brief, concrete reason for every routing decision.`;

  const userText = `Structured interpretation:\n${JSON.stringify(interpretation, null, 2)}`;
  const result = await callGemini(system, userText, PLAN_SCHEMA);
  if (!Array.isArray(result.plan) || result.plan.length === 0) {
    throw new LLMError('Validation failed: planner returned an empty or invalid plan.');
  }
  return result.plan;
}

module.exports = { interpret, plan, LLMError, GEMINI_MODEL };
