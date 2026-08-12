const API = '';

let activeRequestId = null;

async function submitIntake() {
  const text = document.getElementById('intake-text').value.trim();
  const statusEl = document.getElementById('intake-status');
  const btn = document.getElementById('submit-btn');
  if (!text) { statusEl.textContent = 'Please enter some text.'; return; }

  btn.disabled = true;
  statusEl.textContent = 'Running agent pipeline (interpretation -> planning -> tools)...';
  try {
    const res = await fetch(`${API}/api/requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json();
    if (!res.ok) {
      statusEl.textContent = `Failed at stage "${data.stage || 'unknown'}": ${data.error}`;
    } else {
      statusEl.textContent = `Done. Status: ${data.status}.`;
      document.getElementById('intake-text').value = '';
      await refreshList();
      selectRequest(data.requestId);
    }
  } catch (err) {
    statusEl.textContent = `Network error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function refreshList() {
  const res = await fetch(`${API}/api/requests`);
  const items = await res.json();
  const list = document.getElementById('request-list');
  list.innerHTML = '';
  for (const item of items) {
    const li = document.createElement('li');
    li.className = item.id === activeRequestId ? 'active' : '';
    li.innerHTML = `
      <div class="title-row">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="badge ${item.status}">${item.status.replace(/_/g, ' ')}</span>
      </div>
      <div class="muted" style="font-size:12px;margin-top:4px;">${escapeHtml(item.preview)}...</div>
      <div class="muted" style="font-size:11px;margin-top:4px;">${new Date(item.created_at).toLocaleString()}</div>
    `;
    li.onclick = () => selectRequest(item.id);
    list.appendChild(li);
  }
}

async function selectRequest(id) {
  activeRequestId = id;
  await refreshList();
  const res = await fetch(`${API}/api/requests/${id}`);
  const data = await res.json();
  renderDetail(data);
}

function renderDetail(data) {
  const el = document.getElementById('detail-content');
  const interp = data.interpretation;

  let html = `<div class="title-row"><h3 style="margin:0">${escapeHtml(interp?.task_title || '(no title)')}</h3>
    <span class="badge ${data.status}">${data.status.replace(/_/g, ' ')}</span></div>`;

  if (interp) {
    html += `<p>${escapeHtml(interp.summary)}</p>
      <p><strong>Priority:</strong> ${interp.priority} &nbsp; <strong>Deadline:</strong> ${interp.detected_deadline || 'none detected'}</p>`;
    if (interp.missing_information?.length) {
      html += `<div class="section-title">Missing Information</div><ul>${interp.missing_information.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;
    }
    if (interp.could_be_automated?.length) {
      html += `<div class="section-title">Could Be Automated</div><ul>${interp.could_be_automated.map(m => `<li>${escapeHtml(m)}</li>`).join('')}</ul>`;
    }
  } else {
    html += `<p class="muted">Interpretation not available (pipeline may have failed at this stage).</p>`;
  }

  html += `<div class="section-title">Execution Plan &amp; Actions</div>`;
  for (const a of data.actions) {
    html += `<div class="action-card">
      <div class="title-row">
        <span>#${a.seq} ${escapeHtml(a.description)}</span>
        <span class="route-badge route-${a.route}">${a.route.replace('_', ' ')}</span>
      </div>
      <div class="muted" style="font-size:12px;margin:4px 0;">Reason: ${escapeHtml(a.reason)}</div>
      <div class="muted" style="font-size:12px;">Tool: ${a.tool_name}</div>`;

    if (a.error) {
      html += `<div style="color:var(--red);font-size:12px;margin-top:6px;">Error: ${escapeHtml(a.error)}</div>`;
    }
    if (a.tool_output) {
      html += `<pre>${escapeHtml(JSON.stringify(a.tool_output, null, 2))}</pre>`;
    }
    if (a.route === 'human_review') {
      if (a.approval_status === 'pending') {
        html += `<div>
          <button class="small approve" onclick="resolveAction('${a.id}','approve')">Approve</button>
          <button class="small reject" onclick="resolveAction('${a.id}','reject')">Reject</button>
          <button class="small edit" onclick="editAction('${a.id}')">Edit &amp; Approve</button>
        </div>`;
      } else {
        html += `<div class="muted" style="font-size:12px;">Resolution: <strong>${a.approval_status}</strong></div>`;
      }
    }
    html += `</div>`;
  }

  html += `<div class="section-title">Activity Trace</div>`;
  for (const t of data.trace) {
    html += `<div class="trace-line ${t.actor}"><span class="actor">[${t.actor}]</span> ${escapeHtml(t.message)} <span class="muted">(${new Date(t.at).toLocaleTimeString()})</span></div>`;
  }

  html += `<div class="section-title">Original Text</div><pre>${escapeHtml(data.original_text)}</pre>`;

  el.innerHTML = html;
}

async function resolveAction(actionId, decision) {
  const res = await fetch(`${API}/api/actions/${actionId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  await selectRequest(activeRequestId);
}

async function editAction(actionId) {
  const editedBody = prompt('Enter edited output (plain text, will be stored as the final body):');
  if (editedBody === null) return;
  const res = await fetch(`${API}/api/actions/${actionId}/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ decision: 'edit', editedOutput: { body: editedBody, edited: true } })
  });
  const data = await res.json();
  if (!res.ok) { alert(data.error); return; }
  await selectRequest(activeRequestId);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

document.getElementById('submit-btn').addEventListener('click', submitIntake);
document.getElementById('refresh-btn').addEventListener('click', refreshList);
refreshList();
