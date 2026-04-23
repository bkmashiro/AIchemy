/* AIchemy v2 Dashboard — app.js */
'use strict';

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const State = {
  stubs: [],           // Stub[]
  grids: [],           // GridTask[]
  slurmAccounts: [],   // SlurmAccount[]
  alerts: [],          // AnomalyAlert[]
  gpuStats: {},        // { stub_id: GpuStats }
  taskFilter: 'all',
  activeTaskId: null,  // task currently open in modal
  expandedStubs: new Set(),
  expandedGrids: new Set(),
  token: localStorage.getItem('alchemy_token') || '',
};

// ─────────────────────────────────────────────
// Socket.io connection
// ─────────────────────────────────────────────
const socket = io('/web', { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  setStatus('online');
  toast('Connected to AIchemy v2', 'ok');
  // Reload all data
  loadInitialData();
});

socket.on('disconnect', () => {
  setStatus('offline');
  toast('Disconnected', 'err');
});

socket.on('connect_error', () => {
  setStatus('offline');
});

// Full stubs state on connect
socket.on('stubs.update', (stubs) => {
  State.stubs = stubs;
  renderStubs();
  renderTasks();
});

// Individual stub events
socket.on('stub.online', (stub) => {
  // stub.online sends full sanitized stub object
  upsertStub(stub);
  renderStubs();
  renderTasks();
});

socket.on('stub.offline', (payload) => {
  // stub.offline sends { stub_id } or full stub
  const stubId = payload.stub_id || payload.id;
  if (stubId) {
    const stub = State.stubs.find(s => s.id === stubId);
    if (stub) stub.status = 'offline';
  } else {
    upsertStub(payload);
  }
  renderStubs();
  renderTasks();
});

socket.on('stub.update', (stub) => {
  upsertStub(stub);
  renderStubs();
  renderTasks();
});

// Task updates
socket.on('task.update', (task) => {
  // Update in stub list
  for (const stub of State.stubs) {
    const idx = stub.tasks.findIndex(t => t.id === task.id);
    if (idx !== -1) {
      stub.tasks[idx] = task;
      break;
    } else if (stub.id === task.stub_id) {
      stub.tasks.push(task);
      break;
    }
  }
  renderTasks();
  renderStubs();
  // Update modal if open on this task
  if (State.activeTaskId === task.id) {
    updateModalTask(task);
  }
});

// Task logs (real-time)
socket.on('task.log', (payload) => {
  // payload: { task_id, lines }
  if (State.activeTaskId === payload.task_id) {
    appendLogs(payload.lines);
  }
  // Also buffer in task
  const task = findTask(payload.task_id);
  if (task) {
    task.log_buffer = (task.log_buffer || []).concat(payload.lines).slice(-2000);
  }
});

// GPU stats
socket.on('gpu_stats', (payload) => {
  // payload: { stub_id, stats: GpuStats }
  if (payload.stub_id && payload.stats) {
    State.gpuStats[payload.stub_id] = payload.stats;
    const stub = State.stubs.find(s => s.id === payload.stub_id);
    if (stub) {
      stub.gpu_stats = payload.stats;
      renderGpuBars(payload.stub_id, payload.stats);
    }
  }
});

// Grid updates
socket.on('grid.update', (grid) => {
  const idx = State.grids.findIndex(g => g.id === grid.id);
  if (idx !== -1) State.grids[idx] = grid;
  else State.grids.push(grid);
  renderGrids();
});

// Autoqueue submitted
socket.on('autoqueue.submitted', (data) => {
  toast(`AutoQueue: submitted job for ${data.account || '?'}`, 'info');
});

// Workflow events
socket.on('workflow.update', (data) => {
  if (typeof WF !== 'undefined') WF.onWorkflowUpdate(data);
});
socket.on('workflow.node.update', (data) => {
  if (typeof WF !== 'undefined') WF.onNodeUpdate(data);
});

// Workflow Run events
socket.on('workflow.run.update', (data) => {
  if (typeof WF !== 'undefined') WF.onRunUpdate(data);
});
socket.on('workflow.run.node.update', (data) => {
  if (typeof WF !== 'undefined') WF.onRunNodeUpdate(data);
});

// Anomaly alerts
socket.on('anomaly.alert', (alert) => {
  State.alerts.push(alert);
  updateAlertBadge();
  toast(`Alert: ${alert.type} — ${alert.message}`, 'err', 5000);
});

// Walltime warnings
socket.on('walltime.warning', (payload) => {
  const stub = State.stubs.find(s => s.id === payload.stub_id);
  const name = stub ? (stub.name || stub.hostname) : payload.stub_id;
  const remaining = fmtWalltime(payload.remaining_s);
  toast(`Walltime ${payload.level}: ${name} — ${remaining} left`, payload.level === 'critical' ? 'err' : 'info', 6000);
  if (stub) {
    stub.remaining_walltime_s = payload.remaining_s;
    renderStubs();
  }
});

// ─────────────────────────────────────────────
// Initial data load via REST
// ─────────────────────────────────────────────
async function loadInitialData() {
  try {
    const [stubs, grids, accounts, alerts] = await Promise.all([
      api('/api/stubs'),
      api('/api/grids'),
      api('/api/slurm/accounts'),
      api('/api/alerts'),
    ]);
    State.stubs = stubs || [];
    State.grids = grids || [];
    State.slurmAccounts = accounts || [];
    State.alerts = (alerts || []).filter(a => !a.resolved);
    renderAll();
  } catch (e) {
    toast('Failed to load data: ' + e.message, 'err');
  }
}

function renderAll() {
  renderStubs();
  renderTasks();
  renderGrids();
  renderSlurm();
  updateAlertBadge();
}

// ─────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────
async function api(url, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (State.token) headers['Authorization'] = `Bearer ${State.token}`;
  const res = await fetch(url, { headers, ...options });
  if (res.status === 401) {
    showAuthOverlay('Token expired or invalid');
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function upsertStub(stub) {
  const idx = State.stubs.findIndex(s => s.id === stub.id);
  if (idx !== -1) {
    // Preserve tasks if new stub data doesn't have them
    if (!stub.tasks && State.stubs[idx].tasks) stub.tasks = State.stubs[idx].tasks;
    State.stubs[idx] = { ...State.stubs[idx], ...stub };
  } else {
    State.stubs.push(stub);
  }
}

function findTask(taskId) {
  for (const stub of State.stubs) {
    const t = stub.tasks && stub.tasks.find(t => t.id === taskId);
    if (t) return t;
  }
  return null;
}

function findStubForTask(taskId) {
  return State.stubs.find(s => s.tasks && s.tasks.some(t => t.id === taskId));
}

function shortId(id) {
  return id ? id.slice(0, 8) : '—';
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return d.toLocaleDateString();
}

function fmtDuration(task) {
  const start = task.started_at ? new Date(task.started_at) : null;
  const end = task.finished_at ? new Date(task.finished_at) : (task.status === 'running' ? new Date() : null);
  if (!start || !end) return '—';
  const ms = end - start;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtVram(mb) {
  if (!mb) return '—';
  if (mb >= 1024) return `${(mb / 1024).toFixed(0)}G`;
  return `${mb}M`;
}

function fmtWalltime(s) {
  if (!s || s <= 0) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function statusClass(status) {
  return `ts-${status}`;
}

function statusDot(status) {
  const colors = {
    queued: '#94a3b8',
    running: '#3b82f6',
    completed: '#22c55e',
    failed: '#ef4444',
    killed: '#ef4444',
    interrupted: '#f97316',
    paused: '#eab308',
    waiting: '#7a8499',
    blocked: '#7a8499',
    completed_with_errors: '#f59e0b',
    migrating: '#a78bfa',
  };
  const c = colors[status] || '#7a8499';
  return `<span class="status-dot-sm" style="background:${c}"></span>`;
}

function setStatus(state) {
  const dot = document.getElementById('status-dot');
  const txt = document.getElementById('status-text');
  dot.className = '';
  if (state === 'online') {
    dot.classList.add('online');
    txt.textContent = 'Connected';
  } else {
    txt.textContent = 'Disconnected';
  }
}

function toast(msg, type = 'info', duration = 3000) {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function updateAlertBadge() {
  const unresolvedCount = State.alerts.filter(a => !a.resolved).length;
  const badge = document.getElementById('alert-badge');
  document.getElementById('alert-count').textContent = unresolvedCount;
  badge.classList.toggle('visible', unresolvedCount > 0);
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────
// Navigation
// ─────────────────────────────────────────────
const App = window.App = {};

// ─────────────────────────────────────────────
// Auth
// ─────────────────────────────────────────────
function showAuthOverlay(msg) {
  document.getElementById('auth-overlay').style.display = 'flex';
  const errEl = document.getElementById('auth-error');
  if (msg) { errEl.textContent = msg; errEl.style.display = 'block'; }
  else { errEl.style.display = 'none'; }
}

function hideAuthOverlay() {
  document.getElementById('auth-overlay').style.display = 'none';
}

App.login = async function() {
  const input = document.getElementById('auth-token-input');
  const token = input.value.trim();
  if (!token) return;
  State.token = token;
  try {
    await api('/api/stubs');
    localStorage.setItem('alchemy_token', token);
    hideAuthOverlay();
    loadInitialData();
    toast('Authenticated', 'ok');
  } catch (e) {
    State.token = '';
    localStorage.removeItem('alchemy_token');
    document.getElementById('auth-error').textContent = 'Invalid token';
    document.getElementById('auth-error').style.display = 'block';
  }
};

// Auto-auth on load
(async function checkAuth() {
  if (State.token) {
    try {
      await api('/api/stubs');
      hideAuthOverlay();
      return;
    } catch (_) { /* fall through to show overlay */ }
  }
  showAuthOverlay();
})();

App.switchView = function(name) {
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.getElementById(`view-${name}`).classList.add('active');
  document.querySelector(`[data-view="${name}"]`).classList.add('active');

  if (name === 'tasks') renderTasks();
  if (name === 'grids') { loadGrids(); }
  if (name === 'slurm') { loadSlurm(); }
  if (name === 'workflows' && typeof WF !== 'undefined') { WF.loadList(); }
};

// ─────────────────────────────────────────────
// Stubs View
// ─────────────────────────────────────────────
function renderStubs() {
  const container = document.getElementById('stubs-list');
  const count = document.getElementById('stubs-count');

  count.textContent = `${State.stubs.filter(s => s.status === 'online').length} online / ${State.stubs.length} total`;

  if (State.stubs.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="icon">🖥</span><span>No stubs connected</span></div>`;
    return;
  }

  // Sort: online first, then by name
  const sorted = [...State.stubs].sort((a, b) => {
    if (a.status === 'online' && b.status !== 'online') return -1;
    if (a.status !== 'online' && b.status === 'online') return 1;
    return a.name.localeCompare(b.name);
  });

  container.innerHTML = sorted.map(stub => renderStubCard(stub)).join('');
}

function renderStubCard(stub) {
  const tasks = stub.tasks || [];
  const running = tasks.filter(t => t.status === 'running').length;
  const queued = tasks.filter(t => t.status === 'queued').length;
  const statusCls = `status-${stub.status}`;
  const isExpanded = State.expandedStubs.has(stub.id);

  const walltime = stub.remaining_walltime_s;
  let walltimeHtml = '';
  if (walltime && walltime > 0) {
    const total = 72 * 3600; // assume 72h default
    const pct = Math.max(0, Math.min(100, (walltime / total) * 100));
    const cls = pct < 10 ? 'critical' : pct < 25 ? 'low' : '';
    walltimeHtml = `
      <div style="display:flex;align-items:center;gap:6px;margin-top:3px;">
        <span style="font-size:10px;color:var(--text-muted)">Walltime:</span>
        <div class="walltime-bar-track"><div class="walltime-bar-fill ${cls}" style="width:${pct}%"></div></div>
        <span style="font-size:10px;color:var(--text-muted)">${fmtWalltime(walltime)}</span>
      </div>`;
  }

  // GPU stats bars
  let gpuBarsHtml = '';
  const stats = stub.gpu_stats;
  if (stats && stats.gpus && stats.gpus.length > 0) {
    gpuBarsHtml = `<div class="gpu-bars" id="gpu-bars-${stub.id}">` +
      stats.gpus.map(g => {
        const utilPct = g.utilization_pct || 0;
        const memPct = g.memory_total_mb ? Math.round((g.memory_used_mb / g.memory_total_mb) * 100) : 0;
        const utilCls = utilPct > 90 ? 'critical' : utilPct > 70 ? 'high' : '';
        const memCls = memPct > 90 ? 'critical' : memPct > 70 ? 'high' : '';
        return `
          <div class="gpu-bar-row">
            <span class="gpu-bar-label">GPU${g.index}</span>
            <div class="gpu-bar-track"><div class="gpu-bar-fill ${utilCls}" style="width:${utilPct}%"></div></div>
            <span class="gpu-bar-val">${utilPct}%</span>
            <div class="gpu-bar-track"><div class="gpu-bar-fill ${memCls}" style="width:${memPct}%;background:var(--orange)"></div></div>
            <span class="gpu-vram-val">${fmtVram(g.memory_used_mb)}/${fmtVram(g.memory_total_mb)}</span>
            ${g.temperature_c ? `<span style="font-size:10px;color:var(--text-dim);width:32px;text-align:right">${g.temperature_c}°C</span>` : ''}
          </div>`;
      }).join('') + '</div>';
  }

  // Tasks mini table
  let tasksHtml = '';
  if (isExpanded && tasks.length > 0) {
    tasksHtml = `
      <div class="stub-tasks">
        <div class="stub-tasks-header">Tasks (${tasks.length})</div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Command</th><th>Status</th><th>Duration</th><th>Progress</th></tr></thead>
            <tbody>
              ${tasks.map(t => `
                <tr onclick="App.openTask('${t.id}')" title="${escHtml(t.command)}">
                  <td class="td-mono">${shortId(t.id)}</td>
                  <td class="td-cmd">${escHtml(t.command)}</td>
                  <td class="${statusClass(t.status)}">${statusDot(t.status)}${t.status}</td>
                  <td class="td-muted">${fmtDuration(t)}</td>
                  <td>${t.progress ? `<div class="progress-wrap" style="width:80px"><div class="progress-fill" style="width:${Math.round(t.progress.step/t.progress.total*100)}%"></div></div>` : ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  } else if (isExpanded) {
    tasksHtml = `<div class="stub-tasks"><div class="empty-state" style="padding:20px">No tasks</div></div>`;
  }

  return `
    <div class="card stub-card" style="margin-bottom:8px" id="stub-card-${stub.id}">
      <div class="card-header" onclick="App.toggleStub('${stub.id}')">
        <div class="stub-info">
          <span class="stub-name">${escHtml(stub.name || stub.hostname)}</span>
          <span class="stub-meta">${escHtml(stub.hostname)} · ${escHtml(stub.gpu.name)} · ${fmtVram(stub.gpu.vram_total_mb)} · ${stub.gpu.count}× GPU</span>
          ${walltimeHtml}
        </div>
        <div class="stub-right">
          <span class="status-badge ${statusCls}">${stub.status}</span>
          <span class="task-counts">${running} running · ${queued} queued · ${tasks.length} total</span>
          <span style="font-size:10px;color:var(--text-dim)">Connected ${fmtTime(stub.connected_at)}</span>
        </div>
        <span class="collapse-icon" style="margin-left:8px">${isExpanded ? '▼' : '▶'}</span>
      </div>
      ${gpuBarsHtml}
      ${tasksHtml}
    </div>`;
}

function renderGpuBars(stubId, stats) {
  const container = document.getElementById(`gpu-bars-${stubId}`);
  if (!container || !stats || !stats.gpus) return;
  container.innerHTML = stats.gpus.map(g => {
    const utilPct = g.utilization_pct || 0;
    const memPct = g.memory_total_mb ? Math.round((g.memory_used_mb / g.memory_total_mb) * 100) : 0;
    const utilCls = utilPct > 90 ? 'critical' : utilPct > 70 ? 'high' : '';
    const memCls = memPct > 90 ? 'critical' : memPct > 70 ? 'high' : '';
    return `
      <div class="gpu-bar-row">
        <span class="gpu-bar-label">GPU${g.index}</span>
        <div class="gpu-bar-track"><div class="gpu-bar-fill ${utilCls}" style="width:${utilPct}%"></div></div>
        <span class="gpu-bar-val">${utilPct}%</span>
        <div class="gpu-bar-track"><div class="gpu-bar-fill ${memCls}" style="width:${memPct}%;background:var(--orange)"></div></div>
        <span class="gpu-vram-val">${fmtVram(g.memory_used_mb)}/${fmtVram(g.memory_total_mb)}</span>
        ${g.temperature_c ? `<span style="font-size:10px;color:var(--text-dim);width:32px;text-align:right">${g.temperature_c}°C</span>` : ''}
      </div>`;
  }).join('');
}

App.toggleStub = function(stubId) {
  if (State.expandedStubs.has(stubId)) State.expandedStubs.delete(stubId);
  else State.expandedStubs.add(stubId);
  renderStubs();
};

// ─────────────────────────────────────────────
// Tasks View
// ─────────────────────────────────────────────
App.setTaskFilter = function(filter) {
  State.taskFilter = filter;
  document.querySelectorAll('#task-filters .filter-chip').forEach(el => {
    el.classList.toggle('active', el.dataset.filter === filter);
  });
  renderTasks();
};

function getAllTasks() {
  const tasks = [];
  for (const stub of State.stubs) {
    for (const t of (stub.tasks || [])) {
      tasks.push({ ...t, _stubName: stub.name || stub.hostname });
    }
  }
  return tasks;
}

function renderTasks() {
  const tbody = document.getElementById('tasks-tbody');
  const count = document.getElementById('tasks-count');

  let tasks = getAllTasks();
  // Sort: running first, then queued, then by created_at desc
  tasks.sort((a, b) => {
    const order = ['running', 'queued', 'paused', 'waiting', 'blocked', 'migrating', 'failed', 'killed', 'interrupted', 'completed_with_errors', 'completed'];
    const ai = order.indexOf(a.status);
    const bi = order.indexOf(b.status);
    if (ai !== bi) return ai - bi;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const filter = State.taskFilter;
  if (filter !== 'all') {
    if (filter === 'failed') {
      tasks = tasks.filter(t => t.status === 'failed' || t.status === 'killed' || t.status === 'interrupted');
    } else {
      tasks = tasks.filter(t => t.status === filter);
    }
  }

  count.textContent = `${tasks.length} tasks`;

  if (tasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-dim)">No tasks</td></tr>`;
    return;
  }

  tbody.innerHTML = tasks.map(t => {
    const progress = t.progress;
    const pct = progress && progress.total > 0 ? Math.round(progress.step / progress.total * 100) : null;
    return `
      <tr onclick="App.openTask('${t.id}')">
        <td class="td-mono">${shortId(t.id)}</td>
        <td class="td-cmd" title="${escHtml(t.command)}">${escHtml(t.command)}</td>
        <td class="${statusClass(t.status)}">${statusDot(t.status)}${t.status}</td>
        <td class="td-muted">${escHtml(t._stubName || '—')}</td>
        <td class="td-muted">${fmtTime(t.created_at)}</td>
        <td class="td-muted">${fmtDuration(t)}</td>
        <td style="min-width:80px">${pct !== null ?
          `<div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div><div style="font-size:10px;color:var(--text-muted);margin-top:2px">${pct}%${t.progress.loss != null ? ` · loss ${t.progress.loss.toFixed(4)}` : ''}</div>` :
          ''}</td>
      </tr>`;
  }).join('');
}

// ─────────────────────────────────────────────
// Task Modal
// ─────────────────────────────────────────────
App.openTask = async function(taskId) {
  State.activeTaskId = taskId;
  const task = findTask(taskId);
  if (!task) { toast('Task not found', 'err'); return; }

  const stub = findStubForTask(taskId);
  openModal(task, stub);

  // Load logs from REST
  if (stub) {
    try {
      const { lines } = await api(`/api/stubs/${stub.id}/tasks/${taskId}/logs`);
      const logContainer = document.getElementById('log-container');
      if (logContainer) {
        logContainer.innerHTML = '';
        appendLogs(lines);
      }
    } catch (e) {
      // ignore
    }
  }
};

function openModal(task, stub) {
  const overlay = document.getElementById('modal-overlay');
  const title = document.getElementById('modal-title');
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');

  title.innerHTML = `<span class="${statusClass(task.status)}">${statusDot(task.status)}${task.status}</span> <span style="font-family:var(--font-mono);font-size:12px">${shortId(task.id)}</span>`;

  const progress = task.progress;
  const pct = progress && progress.total > 0 ? Math.round(progress.step / progress.total * 100) : null;

  body.innerHTML = `
    <div class="modal-section">
      <div class="modal-label">Command</div>
      <div class="modal-value" style="word-break:break-all">${escHtml(task.command)}</div>
    </div>

    ${task.cwd ? `<div class="modal-section"><div class="modal-label">Working Dir</div><div class="modal-value">${escHtml(task.cwd)}</div></div>` : ''}
    ${task.run_dir ? `<div class="modal-section"><div class="modal-label">Run Dir</div><div class="modal-value">${escHtml(task.run_dir)}</div></div>` : ''}

    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px">
      <div class="modal-section"><div class="modal-label">Stub</div><div class="modal-value">${escHtml(stub ? (stub.name || stub.hostname) : task.stub_id)}</div></div>
      <div class="modal-section"><div class="modal-label">Created</div><div class="modal-value">${task.created_at ? new Date(task.created_at).toLocaleString() : '—'}</div></div>
      <div class="modal-section"><div class="modal-label">Duration</div><div class="modal-value">${fmtDuration(task)}</div></div>
    </div>

    ${pct !== null ? `
      <div class="modal-section">
        <div class="modal-label">Progress — Step ${progress.step}/${progress.total} (${pct}%)${progress.loss != null ? ` · Loss: ${progress.loss.toFixed(6)}` : ''}</div>
        <div class="progress-wrap"><div class="progress-fill" style="width:${pct}%"></div></div>
        ${progress.metrics ? `<div style="font-size:11px;color:var(--text-muted);margin-top:4px;font-family:var(--font-mono)">${Object.entries(progress.metrics).map(([k,v])=>`${k}: ${typeof v==='number'?v.toFixed(4):v}`).join(' · ')}</div>` : ''}
      </div>` : ''}

    ${task.grid_id ? `<div class="modal-section"><div class="modal-label">Grid</div><div class="modal-value">${task.grid_id}</div></div>` : ''}
    ${task.depends_on && task.depends_on.length > 0 ? `<div class="modal-section"><div class="modal-label">Depends On</div><div class="modal-value">${task.depends_on.map(shortId).join(', ')}</div></div>` : ''}

    <div class="modal-section">
      <div class="modal-label">Logs <span style="font-size:10px;color:var(--text-dim)">(real-time)</span></div>
      <div id="log-container"><span style="color:var(--text-dim)">Loading…</span></div>
    </div>
  `;

  // Footer buttons based on status
  footer.innerHTML = buildTaskButtons(task, stub);

  overlay.classList.add('open');
}

function buildTaskButtons(task, stub) {
  const buttons = [];
  if (!stub) return '';

  if (['running', 'queued', 'paused'].includes(task.status)) {
    buttons.push(`<button class="btn btn-danger" onclick="App.killTask('${stub.id}','${task.id}')">Kill</button>`);
  }
  if (task.status === 'running') {
    buttons.push(`<button class="btn btn-warning" onclick="App.pauseTask('${stub.id}','${task.id}')">Pause</button>`);
  }
  if (task.status === 'paused') {
    buttons.push(`<button class="btn btn-success" onclick="App.resumeTask('${stub.id}','${task.id}')">Resume</button>`);
  }
  buttons.push(`<button class="btn btn-sm" onclick="App.copyTaskId('${task.id}')">Copy ID</button>`);
  return buttons.join('');
}

function updateModalTask(task) {
  if (!document.getElementById('modal-overlay').classList.contains('open')) return;
  const stub = findStubForTask(task.id);

  // Update status in title
  const title = document.getElementById('modal-title');
  title.innerHTML = `<span class="${statusClass(task.status)}">${statusDot(task.status)}${task.status}</span> <span style="font-family:var(--font-mono);font-size:12px">${shortId(task.id)}</span>`;

  // Update footer buttons
  document.getElementById('modal-footer').innerHTML = buildTaskButtons(task, stub);

  // Update progress if present
  if (task.progress) {
    const progress = task.progress;
    const pct = progress.total > 0 ? Math.round(progress.step / progress.total * 100) : 0;
    const fill = document.querySelector('#modal-body .progress-fill');
    if (fill) fill.style.width = pct + '%';
  }
}

function appendLogs(lines) {
  const container = document.getElementById('log-container');
  if (!container) return;

  // Remove "Loading…" placeholder
  const placeholder = container.querySelector('span');
  if (placeholder) placeholder.remove();

  lines.forEach(line => {
    const div = document.createElement('div');
    div.className = 'log-line' + (line.includes('Error') || line.includes('error') || line.startsWith('Traceback') ? ' log-err' : '');
    div.textContent = line;
    container.appendChild(div);
  });

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
}

App.killTask = async function(stubId, taskId) {
  try {
    await api(`/api/stubs/${stubId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'kill' }),
    });
    toast('Task killed', 'ok');
  } catch (e) {
    toast('Kill failed: ' + e.message, 'err');
  }
};

App.pauseTask = async function(stubId, taskId) {
  try {
    await api(`/api/stubs/${stubId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'pause' }),
    });
    toast('Task paused', 'ok');
  } catch (e) {
    toast('Pause failed: ' + e.message, 'err');
  }
};

App.resumeTask = async function(stubId, taskId) {
  try {
    await api(`/api/stubs/${stubId}/tasks/${taskId}`, {
      method: 'PATCH',
      body: JSON.stringify({ action: 'resume' }),
    });
    toast('Task resumed', 'ok');
  } catch (e) {
    toast('Resume failed: ' + e.message, 'err');
  }
};

App.copyTaskId = function(taskId) {
  navigator.clipboard.writeText(taskId).then(() => toast('Copied!', 'ok'));
};

App.closeModal = function(event) {
  if (event && event.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.remove('open');
  State.activeTaskId = null;
};

// ─────────────────────────────────────────────
// Grids View
// ─────────────────────────────────────────────
async function loadGrids() {
  try {
    State.grids = await api('/api/grids');
    renderGrids();
  } catch (e) {
    toast('Failed to load grids', 'err');
  }
}

function renderGrids() {
  const container = document.getElementById('grids-list');
  const count = document.getElementById('grids-count');
  count.textContent = `${State.grids.length} grids`;

  if (State.grids.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="icon">⊞</span><span>No grids created</span></div>`;
    return;
  }

  container.innerHTML = State.grids.map(grid => {
    const cells = grid.cells || [];
    const total = cells.length;
    const completed = cells.filter(c => c.status === 'completed').length;
    const running = cells.filter(c => c.status === 'running').length;
    const failed = cells.filter(c => c.status === 'failed').length;
    const pct = total > 0 ? Math.round(completed / total * 100) : 0;
    const isExpanded = State.expandedGrids.has(grid.id);

    const cellsHtml = isExpanded ? `
      <div class="collapsible-content">
        <div style="padding:8px 14px;font-size:11px;color:var(--text-muted);border-bottom:1px solid var(--border)">
          ${total} cells · ${completed} completed · ${running} running · ${failed} failed
          <button class="btn btn-sm" style="float:right;margin-top:-2px" onclick="App.retryFailedCells('${grid.id}')">Retry Failed</button>
          <button class="btn btn-danger btn-sm" style="float:right;margin-right:4px;margin-top:-2px" onclick="App.deleteGrid('${grid.id}')">Delete</button>
        </div>
        <div class="cell-grid" id="cell-grid-${grid.id}">
          ${cells.map(c => `
            <div class="cell-box cell-${c.status}" title="${Object.entries(c.params).map(([k,v])=>`${k}=${v}`).join(', ')}"
              onclick="c => c.stopPropagation(); App.openCellTask('${c.task_id || ''}')"></div>
          `).join('')}
        </div>
        ${isExpanded ? buildCellTable(cells) : ''}
      </div>` : '';

    return `
      <div class="card" style="margin-bottom:8px">
        <div class="card-header" onclick="App.toggleGrid('${grid.id}')">
          <div style="flex:1">
            <div style="font-weight:600;margin-bottom:3px">${escHtml(grid.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${escHtml(grid.command_template)}</div>
          </div>
          <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;min-width:140px">
            <span class="status-badge status-${grid.status === 'completed' ? 'online' : grid.status === 'failed' ? 'offline' : 'stale'}">${grid.status}</span>
            <div style="width:120px">
              <div class="grid-progress-wrap"><div class="grid-progress-fill" style="width:${pct}%"></div></div>
              <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${completed}/${total} (${pct}%)</div>
            </div>
          </div>
          <span class="collapse-icon" style="margin-left:10px">${isExpanded ? '▼' : '▶'}</span>
        </div>
        ${cellsHtml}
      </div>`;
  }).join('');
}

function buildCellTable(cells) {
  if (cells.length === 0) return '';
  const paramKeys = cells.length > 0 ? Object.keys(cells[0].params) : [];
  return `
    <div class="table-wrap" style="border-top:1px solid var(--border)">
      <table>
        <thead><tr>
          ${paramKeys.map(k => `<th>${escHtml(k)}</th>`).join('')}
          <th>Status</th>
          <th>Task</th>
        </tr></thead>
        <tbody>
          ${cells.map(c => `
            <tr onclick="App.openCellTask('${c.task_id || ''}')" style="${c.task_id ? 'cursor:pointer' : ''}">
              ${paramKeys.map(k => `<td class="td-mono">${escHtml(String(c.params[k] ?? ''))}</td>`).join('')}
              <td class="${c.status === 'completed' ? 'ts-completed' : c.status === 'failed' ? 'ts-failed' : c.status === 'running' ? 'ts-running' : 'td-muted'}">${c.status}</td>
              <td class="td-mono">${c.task_id ? shortId(c.task_id) : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

App.toggleGrid = function(gridId) {
  if (State.expandedGrids.has(gridId)) State.expandedGrids.delete(gridId);
  else State.expandedGrids.add(gridId);
  renderGrids();
};

App.openCellTask = function(taskId) {
  if (!taskId) return;
  App.openTask(taskId);
};

App.retryFailedCells = async function(gridId) {
  try {
    const res = await api(`/api/grids/${gridId}/retry-failed`, { method: 'POST', body: '{}' });
    toast(`Retried ${res.retried} cells`, 'ok');
    loadGrids();
  } catch (e) {
    toast('Retry failed: ' + e.message, 'err');
  }
};

App.deleteGrid = async function(gridId) {
  if (!confirm('Delete this grid and kill all running tasks?')) return;
  try {
    await api(`/api/grids/${gridId}`, { method: 'DELETE' });
    toast('Grid deleted', 'ok');
    loadGrids();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
};

App.showCreateGrid = function() {
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  document.getElementById('modal-title').textContent = 'New Grid';

  const stubOptions = State.stubs
    .filter(s => s.status === 'online')
    .map(s => `<option value="${s.id}">${escHtml(s.name || s.hostname)}</option>`)
    .join('');

  body.innerHTML = `
    <div class="form-group">
      <label class="form-label">Grid Name</label>
      <input class="form-input" id="grid-name" placeholder="my-experiment-grid">
    </div>
    <div class="form-group">
      <label class="form-label">Command Template</label>
      <input class="form-input" id="grid-cmd" placeholder="python train.py --lr {lr} --bs {batch_size}">
    </div>
    <div class="form-group">
      <label class="form-label">Parameters (JSON)</label>
      <textarea class="form-textarea" id="grid-params" placeholder='{"lr": [1e-3, 1e-4], "batch_size": [32, 64]}' rows="4"></textarea>
    </div>
    <div class="form-group">
      <label class="form-label">Target Stub (optional)</label>
      <select class="form-select" id="grid-stub">
        <option value="">Auto (best available)</option>
        ${stubOptions}
      </select>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" onclick="App.submitCreateGrid()">Create Grid</button>
    <button class="btn" onclick="App.closeModal()">Cancel</button>
  `;

  document.getElementById('modal-overlay').classList.add('open');
};

App.submitCreateGrid = async function() {
  const name = document.getElementById('grid-name').value.trim();
  const cmd = document.getElementById('grid-cmd').value.trim();
  const paramsRaw = document.getElementById('grid-params').value.trim();
  const stubId = document.getElementById('grid-stub').value;

  if (!name || !cmd || !paramsRaw) { toast('Fill in all required fields', 'err'); return; }

  let params;
  try { params = JSON.parse(paramsRaw); }
  catch (e) { toast('Invalid JSON for parameters', 'err'); return; }

  try {
    const grid = await api('/api/grids', {
      method: 'POST',
      body: JSON.stringify({ name, command_template: cmd, parameters: params, stub_id: stubId || undefined }),
    });
    toast(`Grid created: ${grid.cells.length} cells`, 'ok');
    App.closeModal();
    loadGrids();
    App.switchView('grids');
  } catch (e) {
    toast('Create failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// SLURM Accounts View
// ─────────────────────────────────────────────
async function loadSlurm() {
  try {
    State.slurmAccounts = await api('/api/slurm/accounts');
    renderSlurm();
  } catch (e) {
    toast('Failed to load SLURM accounts', 'err');
  }
}

function renderSlurm() {
  const tbody = document.getElementById('slurm-tbody');

  if (State.slurmAccounts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;padding:30px;color:var(--text-dim)">No SLURM accounts configured</td></tr>`;
    return;
  }

  tbody.innerHTML = State.slurmAccounts.map(acct => {
    const onlineStubs = State.stubs.filter(s => s.slurm_account_id === acct.id && s.status === 'online').length;
    const usage = acct.current_usage || onlineStubs;
    const usagePct = acct.qos_limit > 0 ? Math.round(usage / acct.qos_limit * 100) : 0;

    return `
      <tr onclick="App.toggleSlurmAccount('${acct.id}')">
        <td style="font-weight:600">${escHtml(acct.name)}</td>
        <td class="td-mono">${escHtml(acct.ssh_target)}</td>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <span>${usage}/${acct.qos_limit}</span>
            <div class="gpu-bar-track" style="width:60px"><div class="gpu-bar-fill" style="width:${usagePct}%"></div></div>
          </div>
        </td>
        <td><span style="font-size:11px;color:var(--text-muted)">${(acct.partitions || []).join(', ') || '—'}</span></td>
        <td>${onlineStubs}</td>
        <td>${getAutoQueueStatus(acct.id)}</td>
        <td>
          <button class="btn btn-sm" onclick="event.stopPropagation();App.editAccount('${acct.id}')">Edit</button>
          <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();App.deleteAccount('${acct.id}')">Delete</button>
        </td>
      </tr>
      <tr id="slurm-expand-${acct.id}" style="display:none">
        <td colspan="7" style="padding:0">
          <div class="account-row-expand" id="slurm-expand-body-${acct.id}">Loading…</div>
        </td>
      </tr>`;
  }).join('');
}

function getAutoQueueStatus(accountId) {
  // We'd need to store autoqueue configs in state. For now show a load button.
  return `<button class="btn btn-sm" onclick="event.stopPropagation();App.showAutoQueue('${accountId}')">Config</button>`;
}

App.toggleSlurmAccount = async function(accountId) {
  const row = document.getElementById(`slurm-expand-${accountId}`);
  if (!row) return;
  if (row.style.display === 'none' || !row.style.display) {
    row.style.display = 'table-row';
    // Load autoqueue configs
    try {
      const configs = await api(`/api/slurm/accounts/${accountId}/autoqueue`);
      const body = document.getElementById(`slurm-expand-body-${accountId}`);
      const acct = State.slurmAccounts.find(a => a.id === accountId);
      body.innerHTML = renderAutoQueuePanel(accountId, configs, acct);
    } catch (e) {
      document.getElementById(`slurm-expand-body-${accountId}`).textContent = 'Failed to load';
    }
  } else {
    row.style.display = 'none';
  }
};

function renderAutoQueuePanel(accountId, configs, acct) {
  if (configs.length === 0) {
    return `
      <div style="display:flex;align-items:center;justify-content:space-between">
        <span style="color:var(--text-muted);font-size:12px">No auto-queue config</span>
        <button class="btn btn-primary btn-sm" onclick="App.createAutoQueue('${accountId}')">Enable Auto-Queue</button>
      </div>`;
  }

  return configs.map(cfg => `
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:10px;font-size:12px">
      <div><div class="modal-label">Max Running</div><div class="modal-value">${cfg.max_running}</div></div>
      <div><div class="modal-label">Max Pending</div><div class="modal-value">${cfg.max_pending}</div></div>
      <div><div class="modal-label">QOS Running Limit</div><div class="modal-value">${cfg.qos_running_limit}</div></div>
      <div><div class="modal-label">QOS Pending Limit</div><div class="modal-value">${cfg.qos_pending_limit}</div></div>
      <div><div class="modal-label">Idle Timeout</div><div class="modal-value">${cfg.idle_timeout_min}m</div></div>
      <div><div class="modal-label">Check Interval</div><div class="modal-value">${cfg.check_interval_s}s</div></div>
      <div><div class="modal-label">Status</div><div class="modal-value" style="color:${cfg.enabled ? 'var(--success)' : 'var(--error)'}">${cfg.enabled ? 'Enabled' : 'Disabled'}</div></div>
    </div>
    <div style="display:flex;gap:6px">
      <button class="btn btn-sm ${cfg.enabled ? 'btn-warning' : 'btn-success'}" onclick="App.toggleAutoQueue('${accountId}','${cfg.id}',${!cfg.enabled})">${cfg.enabled ? 'Disable' : 'Enable'}</button>
      <button class="btn btn-danger btn-sm" onclick="App.deleteAutoQueue('${accountId}','${cfg.id}')">Delete</button>
    </div>
  `).join('<hr style="border-color:var(--border);margin:10px 0">');
}

App.showAutoQueue = function(accountId) {
  App.toggleSlurmAccount(accountId);
};

App.createAutoQueue = async function(accountId) {
  const acct = State.slurmAccounts.find(a => a.id === accountId);
  try {
    await api(`/api/slurm/accounts/${accountId}/autoqueue`, {
      method: 'POST',
      body: JSON.stringify({
        max_running: acct ? acct.qos_limit : 5,
        max_pending: acct ? acct.qos_limit : 5,
        qos_running_limit: acct ? acct.qos_limit : 5,
        qos_pending_limit: acct ? acct.qos_limit : 5,
        idle_timeout_min: 30,
        check_interval_s: 60,
        enabled: true,
      }),
    });
    toast('Auto-queue enabled', 'ok');
    App.toggleSlurmAccount(accountId);
    App.toggleSlurmAccount(accountId);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

App.toggleAutoQueue = async function(accountId, configId, enabled) {
  try {
    await api(`/api/slurm/accounts/${accountId}/autoqueue/${configId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    toast(`Auto-queue ${enabled ? 'enabled' : 'disabled'}`, 'ok');
    // Refresh
    const configs = await api(`/api/slurm/accounts/${accountId}/autoqueue`);
    const body = document.getElementById(`slurm-expand-body-${accountId}`);
    const acct = State.slurmAccounts.find(a => a.id === accountId);
    if (body) body.innerHTML = renderAutoQueuePanel(accountId, configs, acct);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

App.deleteAutoQueue = async function(accountId, configId) {
  try {
    await api(`/api/slurm/accounts/${accountId}/autoqueue/${configId}`, { method: 'DELETE' });
    toast('Auto-queue config deleted', 'ok');
    const configs = await api(`/api/slurm/accounts/${accountId}/autoqueue`);
    const body = document.getElementById(`slurm-expand-body-${accountId}`);
    const acct = State.slurmAccounts.find(a => a.id === accountId);
    if (body) body.innerHTML = renderAutoQueuePanel(accountId, configs, acct);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

App.showCreateAccount = function() {
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  document.getElementById('modal-title').textContent = 'Add SLURM Account';

  body.innerHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Account Name</label>
        <input class="form-input" id="acct-name" placeholder="ys25">
      </div>
      <div class="form-group">
        <label class="form-label">SSH Target</label>
        <input class="form-input" id="acct-ssh" placeholder="ys25@gpucluster2">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">QOS Limit</label>
        <input class="form-input" id="acct-qos" type="number" placeholder="5" value="5">
      </div>
      <div class="form-group">
        <label class="form-label">Partitions (comma-separated)</label>
        <input class="form-input" id="acct-parts" placeholder="a40,a30,a100">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Default Walltime</label>
        <input class="form-input" id="acct-walltime" placeholder="72:00:00" value="72:00:00">
      </div>
      <div class="form-group">
        <label class="form-label">Default Memory</label>
        <input class="form-input" id="acct-mem" placeholder="64G" value="64G">
      </div>
    </div>
    <div class="form-group">
      <label class="form-label">Stub Command Template</label>
      <input class="form-input" id="acct-cmd" placeholder="python -m alchemy_stub" value="python -m alchemy_stub">
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" onclick="App.submitCreateAccount()">Add Account</button>
    <button class="btn" onclick="App.closeModal()">Cancel</button>
  `;
  document.getElementById('modal-overlay').classList.add('open');
};

App.submitCreateAccount = async function() {
  const name = document.getElementById('acct-name').value.trim();
  const ssh_target = document.getElementById('acct-ssh').value.trim();
  const qos_limit = parseInt(document.getElementById('acct-qos').value);
  const partitions = document.getElementById('acct-parts').value.split(',').map(s=>s.trim()).filter(Boolean);
  const default_walltime = document.getElementById('acct-walltime').value.trim();
  const default_mem = document.getElementById('acct-mem').value.trim();
  const stub_command = document.getElementById('acct-cmd').value.trim();

  if (!name || !ssh_target || !qos_limit) { toast('Fill in required fields', 'err'); return; }

  try {
    await api('/api/slurm/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, ssh_target, qos_limit, partitions, default_walltime, default_mem, stub_command }),
    });
    toast('Account added', 'ok');
    App.closeModal();
    loadSlurm();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

App.editAccount = function(accountId) {
  const acct = State.slurmAccounts.find(a => a.id === accountId);
  if (!acct) return;

  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  document.getElementById('modal-title').textContent = `Edit: ${acct.name}`;

  body.innerHTML = `
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Account Name</label>
        <input class="form-input" id="edit-acct-name" value="${escHtml(acct.name)}">
      </div>
      <div class="form-group">
        <label class="form-label">SSH Target</label>
        <input class="form-input" id="edit-acct-ssh" value="${escHtml(acct.ssh_target)}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">QOS Limit</label>
        <input class="form-input" id="edit-acct-qos" type="number" value="${acct.qos_limit}">
      </div>
      <div class="form-group">
        <label class="form-label">Partitions (comma-separated)</label>
        <input class="form-input" id="edit-acct-parts" value="${(acct.partitions || []).join(', ')}">
      </div>
    </div>
    <div class="form-row">
      <div class="form-group">
        <label class="form-label">Default Walltime</label>
        <input class="form-input" id="edit-acct-walltime" value="${escHtml(acct.default_walltime)}">
      </div>
      <div class="form-group">
        <label class="form-label">Default Memory</label>
        <input class="form-input" id="edit-acct-mem" value="${escHtml(acct.default_mem)}">
      </div>
    </div>
  `;

  footer.innerHTML = `
    <button class="btn btn-primary" onclick="App.submitEditAccount('${accountId}')">Save</button>
    <button class="btn" onclick="App.closeModal()">Cancel</button>
  `;
  document.getElementById('modal-overlay').classList.add('open');
};

App.submitEditAccount = async function(accountId) {
  const name = document.getElementById('edit-acct-name').value.trim();
  const ssh_target = document.getElementById('edit-acct-ssh').value.trim();
  const qos_limit = parseInt(document.getElementById('edit-acct-qos').value);
  const partitions = document.getElementById('edit-acct-parts').value.split(',').map(s=>s.trim()).filter(Boolean);
  const default_walltime = document.getElementById('edit-acct-walltime').value.trim();
  const default_mem = document.getElementById('edit-acct-mem').value.trim();

  try {
    await api(`/api/slurm/accounts/${accountId}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, ssh_target, qos_limit, partitions, default_walltime, default_mem }),
    });
    toast('Account updated', 'ok');
    App.closeModal();
    loadSlurm();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

App.deleteAccount = async function(accountId) {
  if (!confirm('Delete this SLURM account?')) return;
  try {
    await api(`/api/slurm/accounts/${accountId}`, { method: 'DELETE' });
    toast('Account deleted', 'ok');
    loadSlurm();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────
App.showAlerts = function() {
  const unresolvedAlerts = State.alerts.filter(a => !a.resolved);
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  document.getElementById('modal-title').textContent = `Alerts (${unresolvedAlerts.length})`;

  if (unresolvedAlerts.length === 0) {
    body.innerHTML = `<div class="empty-state"><span>No active alerts</span></div>`;
  } else {
    body.innerHTML = unresolvedAlerts.map(alert => `
      <div style="padding:10px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.2);border-radius:4px;margin-bottom:8px">
        <div style="display:flex;justify-content:space-between;align-items:flex-start">
          <div>
            <span style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--error)">${alert.type}</span>
            <div style="margin-top:4px;font-size:12px">${escHtml(alert.message)}</div>
            <div style="margin-top:4px;font-size:10px;color:var(--text-muted)">
              Stub: ${alert.stub_id} ${alert.task_id ? '· Task: ' + shortId(alert.task_id) : ''} · ${fmtTime(alert.created_at)}
            </div>
          </div>
          <button class="btn btn-sm" onclick="App.resolveAlert('${alert.id}')">Resolve</button>
        </div>
      </div>`).join('');
  }

  footer.innerHTML = `<button class="btn" onclick="App.closeModal()">Close</button>`;
  document.getElementById('modal-overlay').classList.add('open');
};

App.resolveAlert = async function(alertId) {
  try {
    await api(`/api/alerts/${alertId}/resolve`, { method: 'PATCH', body: '{}' });
    State.alerts = State.alerts.map(a => a.id === alertId ? { ...a, resolved: true } : a);
    updateAlertBadge();
    App.showAlerts();
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// Auto-refresh running durations
// ─────────────────────────────────────────────
setInterval(() => {
  // Refresh task durations in running tasks
  const runningRows = document.querySelectorAll('#tasks-tbody tr');
  // Simple approach: just re-render tasks periodically
  const view = document.getElementById('view-tasks');
  if (view && view.classList.contains('active')) {
    renderTasks();
  }
}, 10000);

// ─────────────────────────────────────────────
// Keyboard shortcuts
// ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') App.closeModal();
  if (e.key === '1' && !e.target.matches('input,textarea')) App.switchView('stubs');
  if (e.key === '2' && !e.target.matches('input,textarea')) App.switchView('tasks');
  if (e.key === '3' && !e.target.matches('input,textarea')) App.switchView('grids');
  if (e.key === '4' && !e.target.matches('input,textarea')) App.switchView('slurm');
  if (e.key === '5' && !e.target.matches('input,textarea')) App.switchView('workflows');
});

// Close modal clicking outside
document.getElementById('modal-overlay').addEventListener('click', function(e) {
  if (e.target === this) App.closeModal();
});
