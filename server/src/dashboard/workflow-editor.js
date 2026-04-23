/* AIchemy v2 — Workflow DAG Editor (litegraph.js) */
'use strict';

const WF = window.WF = {};

// ─────────────────────────────────────────────
// State
// ─────────────────────────────────────────────
const WFState = {
  workflows: [],
  current: null,        // current workflow being edited
  validationErrors: {},  // nodeId -> [messages]
  // Run view state
  runs: [],             // WorkflowRun[]
  currentRun: null,     // currently viewed run
  runViewMode: false,   // true when viewing a run (read-only)
  runsExpanded: true,
  // Litegraph
  graph: null,          // LGraph instance
  graphCanvas: null,    // LGraphCanvas instance
  // Map alchemy node id -> litegraph node id (bidirectional)
  alchemyToLG: {},      // alchemy_id -> lg_node_id
  lgToAlchemy: {},      // lg_node_id -> alchemy_id
};

// ─────────────────────────────────────────────
// Port Type Colors & Slot Type IDs
// ─────────────────────────────────────────────
const PORT_COLORS = {
  dir: '#3b82f6',
  file: '#06b6d4',
  checkpoint: '#eab308',
  metrics: '#22c55e',
  params: '#a78bfa',
  number: '#f97316',
  string: '#9ca3af',
  bool: '#ef4444',
  any: '#ffffff',
};

// Litegraph uses numeric slot types for connection validation.
// We assign each alchemy type a unique integer.
const SLOT_TYPE_IDS = {
  dir: 1,
  file: 2,
  checkpoint: 3,
  metrics: 4,
  params: 5,
  number: 6,
  string: 7,
  bool: 8,
  any: 0, // 0 = any, litegraph treats it as wildcard when we handle validation
};

const STATUS_COLORS = {
  pending:   { color: '#2a2a3e', bgcolor: '#1a1a2e' },
  ready:     { color: '#2a2a3e', bgcolor: '#1a1a2e' },
  running:   { color: '#1e3a5f', bgcolor: '#0f2744' },
  completed: { color: '#1a3d2e', bgcolor: '#0f2a1e' },
  failed:    { color: '#3d1a1a', bgcolor: '#2a0f0f' },
  skipped:   { color: '#2a2a1a', bgcolor: '#1e1e0f' },
};

// Type compatibility matrix (source -> set of compatible targets)
const TYPE_COMPAT = {
  dir:        new Set(['dir', 'file', 'any']),
  file:       new Set(['file', 'string', 'any']),
  checkpoint: new Set(['file', 'checkpoint', 'any']),
  metrics:    new Set(['metrics', 'any']),
  params:     new Set(['params', 'any']),
  number:     new Set(['number', 'any']),
  string:     new Set(['string', 'any']),
  bool:       new Set(['bool', 'any']),
  any:        new Set(['dir', 'file', 'checkpoint', 'metrics', 'params', 'number', 'string', 'bool', 'any']),
};

// ─────────────────────────────────────────────
// Node Type Definitions
// ─────────────────────────────────────────────
const NODE_DEFS = {
  compute: {
    label: 'Compute',
    color: '#3b82f6',
    inputs: [
      { name: 'trigger', type: 'any' },
    ],
    outputs: [
      { name: 'run_dir', type: 'dir' },
      { name: 'exit_code', type: 'number' },
    ],
    properties: {
      command: { type: 'string', default: '' },
      env_setup: { type: 'string', default: '' },
      estimated_vram_mb: { type: 'number', default: 0 },
      stub_id: { type: 'string', default: '' },
      timeout_s: { type: 'number', default: 0 },
    },
  },
  copy: {
    label: 'Copy',
    color: '#22c55e',
    inputs: [
      { name: 'source', type: 'dir' },
    ],
    outputs: [
      { name: 'path', type: 'dir' },
    ],
    properties: {
      destination: { type: 'string', default: '' },
    },
  },
  filter: {
    label: 'Filter',
    color: '#f59e0b',
    inputs: [
      { name: 'source_dir', type: 'dir' },
    ],
    outputs: [
      { name: 'selected', type: 'file' },
    ],
    properties: {
      pattern: { type: 'string', default: '' },
      sort_by: { type: 'string', default: '' },
      top_k: { type: 'number', default: 1 },
    },
  },
  branch: {
    label: 'Branch',
    color: '#ef4444',
    inputs: [
      { name: 'condition', type: 'any' },
    ],
    outputs: [
      { name: 'true_branch', type: 'any' },
      { name: 'false_branch', type: 'any' },
    ],
    properties: {
      threshold: { type: 'number', default: 0 },
      operator: { type: 'string', default: 'gt' },
    },
  },
  merge: {
    label: 'Merge',
    color: '#a78bfa',
    inputs: [
      { name: 'input_1', type: 'any' },
      { name: 'input_2', type: 'any' },
      { name: 'input_3', type: 'any' },
    ],
    outputs: [
      { name: 'merged', type: 'dir' },
    ],
    properties: {},
  },
  transform: {
    label: 'Transform',
    color: '#f97316',
    inputs: [
      { name: 'input', type: 'any' },
    ],
    outputs: [
      { name: 'output', type: 'any' },
    ],
    properties: {
      command: { type: 'string', default: '' },
    },
  },
  checkpoint_select: {
    label: 'Checkpoint Select',
    color: '#eab308',
    inputs: [
      { name: 'run_dir', type: 'dir' },
    ],
    outputs: [
      { name: 'checkpoint', type: 'file' },
      { name: 'metric_value', type: 'number' },
    ],
    properties: {
      metric: { type: 'string', default: '' },
      mode: { type: 'string', default: 'min' },
    },
  },
};

// ─────────────────────────────────────────────
// Register litegraph slot colors
// ─────────────────────────────────────────────
function initLitegraphTheme() {
  if (typeof LiteGraph === 'undefined') return;

  // Register slot type colors
  LiteGraph.slot_types_default_out = {};
  LiteGraph.slot_types_default_in = {};

  // Register type colors on the canvas
  for (const [typeName, color] of Object.entries(PORT_COLORS)) {
    const typeId = SLOT_TYPE_IDS[typeName];
    if (typeId !== undefined) {
      LiteGraph.LINK_COLOR = '#4a5568';
      // We use string type names as slot types for clarity
    }
  }

  // Dark theme defaults
  LiteGraph.DEFAULT_BACKGROUND_COLOR = '#1a1a2e';
  LiteGraph.NODE_DEFAULT_COLOR = '#2a2a3e';
  LiteGraph.NODE_DEFAULT_BGCOLOR = '#16213e';
  LiteGraph.NODE_DEFAULT_BOXCOLOR = '#4a5568';
  LiteGraph.NODE_TITLE_COLOR = '#e0e0e0';
  LiteGraph.NODE_TEXT_COLOR = '#c0c0c0';
  LiteGraph.LINK_COLOR = '#4a5568';
  LiteGraph.DEFAULT_SHADOW_COLOR = 'rgba(0,0,0,0.5)';
  LiteGraph.WIDGET_BGCOLOR = '#0d1526';
  LiteGraph.WIDGET_OUTLINE_COLOR = '#1e2d4a';
  LiteGraph.WIDGET_TEXT_COLOR = '#e0e0e0';
  LiteGraph.WIDGET_SECONDARY_TEXT_COLOR = '#7a8499';
}

// ─────────────────────────────────────────────
// Register Custom Node Types
// ─────────────────────────────────────────────
function registerNodeTypes() {
  if (typeof LiteGraph === 'undefined') return;

  for (const [typeName, def] of Object.entries(NODE_DEFS)) {
    const nodeClass = createNodeClass(typeName, def);
    LiteGraph.registerNodeType('alchemy/' + typeName, nodeClass);
  }
}

function createNodeClass(typeName, def) {
  function AlchemyNode() {
    // Add inputs
    for (const inp of def.inputs) {
      this.addInput(inp.name, inp.type);
    }
    // Add outputs
    for (const out of def.outputs) {
      this.addOutput(out.name, out.type);
    }
    // Set default properties
    for (const [key, propDef] of Object.entries(def.properties || {})) {
      this.addProperty(key, propDef.default, propDef.type);
    }
    // Custom metadata
    this.alchemy_type = typeName;
    this.alchemy_id = null;  // set when loading from alchemy format
    this.alchemy_status = 'pending';
    this.alchemy_run_data = null;

    this.color = STATUS_COLORS.pending.color;
    this.bgcolor = STATUS_COLORS.pending.bgcolor;
    this.size = [220, 80];

    // Widgets for properties
    this._createWidgets(def);
  }

  AlchemyNode.title = def.label;
  AlchemyNode.title_color = def.color;

  AlchemyNode.prototype._createWidgets = function(def) {
    for (const [key, propDef] of Object.entries(def.properties || {})) {
      if (key === 'operator') {
        this.addWidget('combo', key, propDef.default, (v) => { this.properties[key] = v; }, { values: ['gt', 'lt', 'eq'] });
      } else if (key === 'mode') {
        this.addWidget('combo', key, propDef.default, (v) => { this.properties[key] = v; }, { values: ['min', 'max'] });
      } else if (key === 'stub_id') {
        // Stub select - combo populated dynamically
        const stubs = (typeof State !== 'undefined' ? State.stubs : []).filter(s => s.status === 'online');
        const vals = [''].concat(stubs.map(s => s.id));
        const valNames = { '': 'Auto' };
        stubs.forEach(s => { valNames[s.id] = s.name || s.hostname; });
        this.addWidget('combo', key, propDef.default, (v) => { this.properties[key] = v; }, { values: vals });
      } else if (propDef.type === 'number') {
        this.addWidget('number', key, propDef.default, (v) => { this.properties[key] = v; }, { min: 0, step: 1 });
      } else if (key === 'command') {
        this.addWidget('text', key, propDef.default, (v) => { this.properties[key] = v; });
      } else {
        this.addWidget('text', key, propDef.default, (v) => { this.properties[key] = v; });
      }
    }
  };

  // Connection validation
  AlchemyNode.prototype.onConnectInput = function(inputIndex, outputType, outputSlot, outputNode, outputIndex) {
    if (WFState.runViewMode) return false;
    const inputSlot = this.inputs[inputIndex];
    if (!inputSlot) return false;
    const inType = inputSlot.type;
    const outType = outputType;
    return isTypeCompatible(outType, inType);
  };

  // Draw status indicator
  AlchemyNode.prototype.onDrawForeground = function(ctx) {
    const status = this.alchemy_status;
    if (status === 'running') {
      // Pulsing border
      const t = (Date.now() % 2000) / 2000;
      const alpha = 0.3 + 0.4 * Math.sin(t * Math.PI * 2);
      ctx.strokeStyle = `rgba(59, 130, 246, ${alpha})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(-3, -LiteGraph.NODE_TITLE_HEIGHT - 3, this.size[0] + 6, this.size[1] + LiteGraph.NODE_TITLE_HEIGHT + 6);
      // Force continuous redraw
      this.setDirtyCanvas(true, false);
    }

    // Status dot in top-right
    const dotColors = {
      pending: '#94a3b8', ready: '#94a3b8', running: '#3b82f6',
      completed: '#22c55e', failed: '#ef4444', skipped: '#eab308',
    };
    const dotColor = dotColors[status] || '#94a3b8';
    ctx.fillStyle = dotColor;
    ctx.beginPath();
    ctx.arc(this.size[0] - 10, -LiteGraph.NODE_TITLE_HEIGHT + 10, 4, 0, Math.PI * 2);
    ctx.fill();
  };

  // Override getSlotColor to use our port colors
  AlchemyNode.prototype.getSlotColor = function(slot) {
    return PORT_COLORS[slot.type] || PORT_COLORS.any;
  };

  return AlchemyNode;
}

function isTypeCompatible(outputType, inputType) {
  if (!outputType || !inputType) return true;
  if (inputType === 'any' || outputType === 'any') return true;
  if (inputType === outputType) return true;
  const compat = TYPE_COMPAT[outputType];
  return compat ? compat.has(inputType) : false;
}

// ─────────────────────────────────────────────
// Workflow List
// ─────────────────────────────────────────────
WF.loadList = async function() {
  try {
    WFState.workflows = await api('/api/workflows');
  } catch (e) {
    WFState.workflows = [];
  }
  renderWorkflowList();
};

function renderWorkflowList() {
  const container = document.getElementById('wf-list');
  const count = document.getElementById('wf-count');
  const wfs = WFState.workflows || [];
  count.textContent = `${wfs.length} workflows`;

  if (wfs.length === 0) {
    container.innerHTML = '<div class="empty-state"><span class="icon">\u25C6</span><span>No workflows yet</span></div>';
    return;
  }

  container.innerHTML = wfs.map(w => {
    const nodeCount = (w.nodes || []).length;
    const statusCls = w.status === 'completed' ? 'status-online' : w.status === 'failed' ? 'status-offline' : 'status-stale';
    return `
      <div class="card" style="margin-bottom:8px;cursor:pointer" onclick="WF.openEditor('${w.id}')">
        <div class="card-header">
          <div style="flex:1">
            <div style="font-weight:600;margin-bottom:3px">${escHtml(w.name || 'Untitled')}</div>
            <div style="font-size:11px;color:var(--text-muted)">${escHtml(w.description || '')}</div>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span style="font-size:11px;color:var(--text-muted)">${nodeCount} nodes</span>
            <span class="status-badge ${statusCls}">${w.status || 'draft'}</span>
            <span style="font-size:10px;color:var(--text-dim)">${fmtTime(w.created_at)}</span>
            <button class="btn btn-danger btn-sm" onclick="event.stopPropagation();WF.deleteWorkflow('${w.id}')">Delete</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

WF.createNew = async function() {
  try {
    const w = await api('/api/workflows', {
      method: 'POST',
      body: JSON.stringify({ name: 'Untitled Workflow', nodes: [], edges: [] }),
    });
    toast('Workflow created', 'ok');
    WF.openEditor(w.id);
  } catch (e) {
    toast('Failed: ' + e.message, 'err');
  }
};

WF.deleteWorkflow = async function(id) {
  if (!confirm('Delete this workflow?')) return;
  try {
    await api(`/api/workflows/${id}`, { method: 'DELETE' });
    toast('Deleted', 'ok');
    WF.loadList();
  } catch (e) {
    toast('Delete failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// Editor Open / Close
// ─────────────────────────────────────────────
WF.openEditor = async function(id) {
  try {
    const w = await api(`/api/workflows/${id}`);
    WFState.current = w;
    WFState.validationErrors = {};

    showEditorMode(true);
    updateToolbar();
    initGraph();
    alchemyToLitegraph(w);
    WF.loadRuns();
  } catch (e) {
    toast('Failed to load workflow: ' + e.message, 'err');
  }
};

WF.backToList = function() {
  destroyGraph();
  showEditorMode(false);
  WFState.current = null;
  WF.loadList();
};

function showEditorMode(show) {
  document.getElementById('wf-list-mode').style.display = show ? 'none' : '';
  const editor = document.getElementById('wf-editor-mode');
  editor.style.display = show ? 'flex' : 'none';
  if (show) {
    WF.exitRunView();
  }
}

function updateToolbar() {
  const w = WFState.current;
  if (!w) return;

  const inRunView = WFState.runViewMode;
  const run = WFState.currentRun;

  if (inRunView && run) {
    document.getElementById('wf-editor-title').textContent = (w.name || 'Untitled') + ' \u2014 Run';
    const statusEl = document.getElementById('wf-editor-status');
    const s = run.status || 'pending';
    statusEl.textContent = s;
    statusEl.className = 'status-badge status-' + s;

    document.getElementById('wf-btn-autolayout').style.display = 'none';
    document.getElementById('wf-btn-validate').style.display = 'none';
    document.getElementById('wf-btn-save').style.display = 'none';
    document.getElementById('wf-btn-run').style.display = 'none';

    const isActive = s === 'running' || s === 'paused';
    document.getElementById('wf-btn-pause').style.display = s === 'running' ? '' : 'none';
    document.getElementById('wf-btn-resume').style.display = s === 'paused' ? '' : 'none';
    document.getElementById('wf-btn-cancel').style.display = isActive ? '' : 'none';
    document.getElementById('wf-btn-retry').style.display = s === 'failed' ? '' : 'none';

    document.getElementById('wf-btn-back').onclick = function() { WF.exitRunView(); };
  } else {
    document.getElementById('wf-editor-title').textContent = w.name || 'Untitled';
    const statusEl = document.getElementById('wf-editor-status');
    const s = w.status || 'draft';
    statusEl.textContent = s;
    statusEl.className = 'status-badge ' + (s === 'completed' ? 'status-online' : s === 'failed' ? 'status-offline' : 'status-stale');

    document.getElementById('wf-btn-autolayout').style.display = '';
    document.getElementById('wf-btn-validate').style.display = '';
    document.getElementById('wf-btn-save').style.display = '';
    document.getElementById('wf-btn-retry').style.display = 'none';

    const isRunning = s === 'running' || s === 'paused';
    document.getElementById('wf-btn-run').style.display = isRunning ? 'none' : '';
    document.getElementById('wf-btn-pause').style.display = s === 'running' ? '' : 'none';
    document.getElementById('wf-btn-resume').style.display = s === 'paused' ? '' : 'none';
    document.getElementById('wf-btn-cancel').style.display = isRunning ? '' : 'none';

    document.getElementById('wf-btn-back').onclick = function() { WF.backToList(); };
  }
}

// ─────────────────────────────────────────────
// Litegraph Init / Destroy
// ─────────────────────────────────────────────
function initGraph() {
  destroyGraph();

  const canvas = document.getElementById('wf-litegraph-canvas');
  const container = document.getElementById('wf-editor-body');

  // Size canvas to container
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight;

  WFState.graph = new LGraph();
  WFState.graphCanvas = new LGraphCanvas(canvas, WFState.graph);

  // Theme
  const gc = WFState.graphCanvas;
  gc.background_image = null;
  gc.clear_background_color = '#1a1a2e';
  gc.render_canvas_border = false;
  gc.render_connections_border = false;
  gc.highquality_render = true;
  gc.render_curved_connections = true;
  gc.render_connection_arrows = false;
  gc.default_connection_color_byType = {};

  // Set slot colors by type name
  for (const [typeName, color] of Object.entries(PORT_COLORS)) {
    gc.default_connection_color_byType[typeName] = color;
  }

  // Handle drag-to-empty: show filtered node menu
  gc.onConnectionCreated = null;
  gc.onShowSearchBox = null;

  // Handle releasing a link on empty canvas
  gc.onDropUnconnectedLink = function(slot, e) {
    if (WFState.runViewMode) return;
    const isOutput = slot.output;
    const slotType = isOutput ? slot.output.type : slot.input.type;
    const pos = [e.canvasX, e.canvasY];

    // Build filtered node list
    const entries = [];
    for (const [typeName, def] of Object.entries(NODE_DEFS)) {
      const ports = isOutput ? def.inputs : def.outputs;
      const hasCompat = ports.some(p => isTypeCompatible(
        isOutput ? slotType : p.type,
        isOutput ? p.type : slotType
      ));
      if (hasCompat) {
        entries.push({
          content: def.label,
          callback: () => {
            const lgNode = LiteGraph.createNode('alchemy/' + typeName);
            lgNode.pos = pos;
            WFState.graph.add(lgNode);
          }
        });
      }
    }

    if (entries.length > 0) {
      new LiteGraph.ContextMenu(entries, { event: e, parentMenu: null }, gc.getCanvasWindow());
    }
  };

  // Start rendering
  WFState.graph.start();

  // Resize handler
  WFState._resizeHandler = () => {
    const c = document.getElementById('wf-litegraph-canvas');
    const ct = document.getElementById('wf-editor-body');
    if (c && ct) {
      // Account for props panel width
      const propsPanel = document.getElementById('wf-props');
      const propsWidth = propsPanel && propsPanel.style.display !== 'none' ? propsPanel.offsetWidth : 0;
      c.width = ct.clientWidth - propsWidth;
      c.height = ct.clientHeight;
      if (WFState.graphCanvas) WFState.graphCanvas.resize();
    }
  };
  window.addEventListener('resize', WFState._resizeHandler);
}

function destroyGraph() {
  if (WFState.graph) {
    WFState.graph.stop();
    WFState.graph.clear();
    WFState.graph = null;
  }
  if (WFState.graphCanvas) {
    WFState.graphCanvas = null;
  }
  if (WFState._resizeHandler) {
    window.removeEventListener('resize', WFState._resizeHandler);
    WFState._resizeHandler = null;
  }
  WFState.alchemyToLG = {};
  WFState.lgToAlchemy = {};
}

// ─────────────────────────────────────────────
// Serialization: Alchemy → Litegraph
// ─────────────────────────────────────────────
function alchemyToLitegraph(workflow) {
  const graph = WFState.graph;
  if (!graph) return;

  graph.clear();
  WFState.alchemyToLG = {};
  WFState.lgToAlchemy = {};

  const nodes = workflow.nodes || [];
  const edges = workflow.edges || [];

  // Create nodes
  for (const aNode of nodes) {
    const typePath = 'alchemy/' + aNode.type;
    const lgNode = LiteGraph.createNode(typePath);
    if (!lgNode) continue;

    lgNode.pos = [aNode.position?.x || 0, aNode.position?.y || 0];
    lgNode.title = aNode.label || NODE_DEFS[aNode.type]?.label || aNode.type;
    lgNode.alchemy_id = aNode.id;
    lgNode.alchemy_type = aNode.type;
    lgNode.alchemy_status = aNode.status || 'pending';

    // Set properties from config
    if (aNode.config) {
      for (const [key, val] of Object.entries(aNode.config)) {
        if (lgNode.properties.hasOwnProperty(key)) {
          lgNode.properties[key] = val;
          // Update widget value
          const widget = lgNode.widgets?.find(w => w.name === key);
          if (widget) widget.value = val;
        }
      }
    }

    // Apply status colors
    applyStatusToNode(lgNode, lgNode.alchemy_status);

    graph.add(lgNode);
    WFState.alchemyToLG[aNode.id] = lgNode.id;
    WFState.lgToAlchemy[lgNode.id] = aNode.id;
  }

  // Create edges
  for (const edge of edges) {
    const srcLGId = WFState.alchemyToLG[edge.source_node];
    const tgtLGId = WFState.alchemyToLG[edge.target_node];
    if (srcLGId == null || tgtLGId == null) continue;

    const srcNode = graph.getNodeById(srcLGId);
    const tgtNode = graph.getNodeById(tgtLGId);
    if (!srcNode || !tgtNode) continue;

    // Find output slot index by port name
    const srcPortName = edge.source_port;
    const tgtPortName = edge.target_port;

    // Port name could be like "n1_out_run_dir" or just "run_dir"
    const outIdx = findSlotIndex(srcNode.outputs, srcPortName);
    const inIdx = findSlotIndex(tgtNode.inputs, tgtPortName);

    if (outIdx !== -1 && inIdx !== -1) {
      srcNode.connect(outIdx, tgtNode, inIdx);
    }
  }

  // Center view on graph
  if (WFState.graphCanvas && nodes.length > 0) {
    setTimeout(() => {
      WFState.graphCanvas.ds.reset();
      WFState.graphCanvas.centerOnGraph();
    }, 100);
  }
}

function findSlotIndex(slots, portName) {
  if (!slots) return -1;
  // Try exact match first
  let idx = slots.findIndex(s => s.name === portName);
  if (idx !== -1) return idx;
  // Try matching the suffix (e.g., "n1_out_run_dir" -> "run_dir")
  const parts = portName.split('_');
  // Walk from end, try progressively longer suffixes
  for (let i = parts.length - 1; i >= 0; i--) {
    const suffix = parts.slice(i).join('_');
    idx = slots.findIndex(s => s.name === suffix);
    if (idx !== -1) return idx;
  }
  return -1;
}

// ─────────────────────────────────────────────
// Serialization: Litegraph → Alchemy
// ─────────────────────────────────────────────
function litegraphToAlchemy() {
  const graph = WFState.graph;
  if (!graph) return { nodes: [], edges: [] };

  const alchemyNodes = [];
  const alchemyEdges = [];
  let edgeId = 1;

  // Build nodes
  const lgNodes = graph._nodes || [];
  for (const lgNode of lgNodes) {
    const typeName = lgNode.alchemy_type || lgNode.type?.replace('alchemy/', '') || 'compute';
    const def = NODE_DEFS[typeName];
    if (!def) continue;

    const alchemyId = lgNode.alchemy_id || `n${lgNode.id}`;

    // Build config from properties
    const config = {};
    for (const key of Object.keys(def.properties || {})) {
      if (lgNode.properties[key] !== undefined && lgNode.properties[key] !== '' && lgNode.properties[key] !== 0) {
        config[key] = lgNode.properties[key];
      }
    }

    // Build port arrays
    const inputs = (lgNode.inputs || []).map(inp => ({
      id: `${alchemyId}_in_${inp.name}`,
      name: inp.name,
      type: inp.type || 'any',
      required: false,
    }));

    const outputs = (lgNode.outputs || []).map(out => ({
      id: `${alchemyId}_out_${out.name}`,
      name: out.name,
      type: out.type || 'any',
    }));

    alchemyNodes.push({
      id: alchemyId,
      type: typeName,
      label: lgNode.title || def.label,
      config,
      position: { x: Math.round(lgNode.pos[0]), y: Math.round(lgNode.pos[1]) },
      inputs,
      outputs,
      status: lgNode.alchemy_status || 'pending',
    });

    // Update ID map
    WFState.alchemyToLG[alchemyId] = lgNode.id;
    WFState.lgToAlchemy[lgNode.id] = alchemyId;
  }

  // Build edges from litegraph links
  const links = graph.links || {};
  for (const linkId in links) {
    const link = links[linkId];
    if (!link) continue;

    const srcLGNode = graph.getNodeById(link.origin_id);
    const tgtLGNode = graph.getNodeById(link.target_id);
    if (!srcLGNode || !tgtLGNode) continue;

    const srcAlchemyId = WFState.lgToAlchemy[srcLGNode.id] || `n${srcLGNode.id}`;
    const tgtAlchemyId = WFState.lgToAlchemy[tgtLGNode.id] || `n${tgtLGNode.id}`;

    const srcSlot = srcLGNode.outputs?.[link.origin_slot];
    const tgtSlot = tgtLGNode.inputs?.[link.target_slot];

    if (!srcSlot || !tgtSlot) continue;

    // Use the standard port ID format
    const srcPortId = `${srcAlchemyId}_out_${srcSlot.name}`;
    const tgtPortId = `${tgtAlchemyId}_in_${tgtSlot.name}`;

    alchemyEdges.push({
      id: `e${edgeId++}`,
      source_node: srcAlchemyId,
      source_port: srcPortId,
      target_node: tgtAlchemyId,
      target_port: tgtPortId,
    });
  }

  return { nodes: alchemyNodes, edges: alchemyEdges };
}

// ─────────────────────────────────────────────
// Status Visualization
// ─────────────────────────────────────────────
function applyStatusToNode(lgNode, status) {
  lgNode.alchemy_status = status;
  const colors = STATUS_COLORS[status] || STATUS_COLORS.pending;
  lgNode.color = colors.color;
  lgNode.bgcolor = colors.bgcolor;

  // Boxcolor for the title bar
  const boxColors = {
    pending: '#4a5568', ready: '#4a5568', running: '#3b82f6',
    completed: '#22c55e', failed: '#ef4444', skipped: '#eab308',
  };
  lgNode.boxcolor = boxColors[status] || '#4a5568';
}

// ─────────────────────────────────────────────
// Toolbar Actions
// ─────────────────────────────────────────────
WF.save = async function() {
  if (!WFState.current) return;
  try {
    const data = litegraphToAlchemy();
    const updated = await api(`/api/workflows/${WFState.current.id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
    WFState.current = { ...WFState.current, ...updated };
    toast('Saved', 'ok');
  } catch (e) {
    toast('Save failed: ' + e.message, 'err');
  }
};

WF.validate = async function() {
  if (!WFState.current) return;
  await WF.save();
  try {
    const result = await api(`/api/workflows/${WFState.current.id}/validate`, { method: 'POST', body: '{}' });
    WFState.validationErrors = {};
    if (result.errors) {
      result.errors.forEach(err => {
        if (err.node_id) {
          if (!WFState.validationErrors[err.node_id]) WFState.validationErrors[err.node_id] = [];
          WFState.validationErrors[err.node_id].push(err.message);
        }
      });
    }
    // Show errors on nodes (as badges/marks)
    applyValidationErrors();
    if (result.valid) {
      toast('Validation passed', 'ok');
    } else {
      toast(`Validation: ${(result.errors || []).length} errors`, 'err');
    }
  } catch (e) {
    toast('Validate failed: ' + e.message, 'err');
  }
};

function applyValidationErrors() {
  const graph = WFState.graph;
  if (!graph) return;
  for (const lgNode of (graph._nodes || [])) {
    const alchemyId = WFState.lgToAlchemy[lgNode.id];
    const errors = WFState.validationErrors[alchemyId];
    if (errors && errors.length > 0) {
      lgNode.boxcolor = '#ef4444';
      lgNode._validationErrors = errors;
    } else {
      delete lgNode._validationErrors;
      // Restore boxcolor from status
      const boxColors = {
        pending: '#4a5568', ready: '#4a5568', running: '#3b82f6',
        completed: '#22c55e', failed: '#ef4444', skipped: '#eab308',
      };
      lgNode.boxcolor = boxColors[lgNode.alchemy_status] || '#4a5568';
    }
  }
  if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
}

WF.run = async function() {
  if (!WFState.current) return;
  await WF.save();

  const variables = WFState.current.variables;
  if (variables && Array.isArray(variables) && variables.length > 0) {
    WF.showVariableDialog(variables);
    return;
  }

  WF.executeRun({});
};

WF.showVariableDialog = function(variables) {
  const body = document.getElementById('modal-body');
  const footer = document.getElementById('modal-footer');
  document.getElementById('modal-title').textContent = 'Run Variables';

  let html = '<div class="wf-var-form">';
  variables.forEach((v, i) => {
    const id = `wf-var-${i}`;
    const labelCls = v.required ? 'form-label wf-var-required' : 'form-label';
    if (v.type === 'boolean') {
      html += `<div class="form-group">
        <label class="${labelCls}">${escHtml(v.name)}</label>
        <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer">
          <input type="checkbox" id="${id}" ${v.default ? 'checked' : ''} data-var-name="${escHtml(v.name)}" data-var-type="boolean">
          ${escHtml(v.description || '')}
        </label>
      </div>`;
    } else if (v.type === 'number') {
      html += `<div class="form-group">
        <label class="${labelCls}">${escHtml(v.name)}</label>
        ${v.description ? `<div style="font-size:10px;color:var(--text-dim)">${escHtml(v.description)}</div>` : ''}
        <input class="form-input" type="number" id="${id}" value="${v.default != null ? v.default : ''}" data-var-name="${escHtml(v.name)}" data-var-type="number" placeholder="${escHtml(v.name)}">
      </div>`;
    } else {
      html += `<div class="form-group">
        <label class="${labelCls}">${escHtml(v.name)}</label>
        ${v.description ? `<div style="font-size:10px;color:var(--text-dim)">${escHtml(v.description)}</div>` : ''}
        <input class="form-input" type="text" id="${id}" value="${escHtml(String(v.default != null ? v.default : ''))}" data-var-name="${escHtml(v.name)}" data-var-type="string" placeholder="${escHtml(v.name)}">
      </div>`;
    }
  });
  html += '</div>';
  body.innerHTML = html;

  footer.innerHTML = `
    <button class="btn btn-primary" onclick="WF.submitVariableDialog()">Run</button>
    <button class="btn" onclick="App.closeModal()">Cancel</button>
  `;
  document.getElementById('modal-overlay').classList.add('open');
};

WF.submitVariableDialog = function() {
  const inputs = document.querySelectorAll('[data-var-name]');
  const vars = {};
  let valid = true;

  inputs.forEach(el => {
    const name = el.dataset.varName;
    const type = el.dataset.varType;
    if (type === 'boolean') {
      vars[name] = el.checked;
    } else if (type === 'number') {
      const v = el.value.trim();
      if (v === '') {
        const variable = (WFState.current.variables || []).find(vr => vr.name === name);
        if (variable && variable.required) {
          el.style.borderColor = 'var(--error)';
          valid = false;
        }
      } else {
        vars[name] = parseFloat(v);
      }
    } else {
      const v = el.value;
      const variable = (WFState.current.variables || []).find(vr => vr.name === name);
      if (!v && variable && variable.required) {
        el.style.borderColor = 'var(--error)';
        valid = false;
      }
      if (v) vars[name] = v;
    }
  });

  if (!valid) {
    toast('Fill in required fields', 'err');
    return;
  }

  App.closeModal();
  WF.executeRun(vars);
};

WF.executeRun = async function(variables) {
  try {
    const result = await api(`/api/workflows/${WFState.current.id}/run`, {
      method: 'POST',
      body: JSON.stringify({ variables }),
    });
    WFState.current.status = 'running';
    updateToolbar();
    toast('Workflow started', 'ok');
    WF.loadRuns();
  } catch (e) {
    toast('Run failed: ' + e.message, 'err');
  }
};

WF.pause = async function() {
  if (!WFState.current) return;
  const url = WFState.runViewMode && WFState.currentRun
    ? `/api/workflows/${WFState.current.id}/runs/${WFState.currentRun.id}/pause`
    : `/api/workflows/${WFState.current.id}/pause`;
  try {
    await api(url, { method: 'POST', body: '{}' });
    if (WFState.runViewMode && WFState.currentRun) {
      WFState.currentRun.status = 'paused';
    } else {
      WFState.current.status = 'paused';
    }
    updateToolbar();
    toast('Paused', 'ok');
  } catch (e) {
    toast('Pause failed: ' + e.message, 'err');
  }
};

WF.resume = async function() {
  if (!WFState.current) return;
  const url = WFState.runViewMode && WFState.currentRun
    ? `/api/workflows/${WFState.current.id}/runs/${WFState.currentRun.id}/resume`
    : `/api/workflows/${WFState.current.id}/resume`;
  try {
    await api(url, { method: 'POST', body: '{}' });
    if (WFState.runViewMode && WFState.currentRun) {
      WFState.currentRun.status = 'running';
    } else {
      WFState.current.status = 'running';
    }
    updateToolbar();
    toast('Resumed', 'ok');
  } catch (e) {
    toast('Resume failed: ' + e.message, 'err');
  }
};

WF.cancel = async function() {
  if (!WFState.current) return;
  if (!confirm('Cancel this workflow run?')) return;
  const url = WFState.runViewMode && WFState.currentRun
    ? `/api/workflows/${WFState.current.id}/runs/${WFState.currentRun.id}/cancel`
    : `/api/workflows/${WFState.current.id}/cancel`;
  try {
    await api(url, { method: 'POST', body: '{}' });
    if (WFState.runViewMode && WFState.currentRun) {
      WFState.currentRun.status = 'cancelled';
    } else {
      WFState.current.status = 'failed';
    }
    updateToolbar();
    toast('Cancelled', 'ok');
  } catch (e) {
    toast('Cancel failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// Auto Layout (topological left-to-right)
// ─────────────────────────────────────────────
WF.autoLayout = function() {
  const graph = WFState.graph;
  if (!graph) return;

  const lgNodes = graph._nodes || [];
  if (lgNodes.length === 0) return;

  // Build adjacency from litegraph links
  const incoming = {};
  const outgoing = {};
  lgNodes.forEach(n => { incoming[n.id] = []; outgoing[n.id] = []; });

  const links = graph.links || {};
  for (const linkId in links) {
    const link = links[linkId];
    if (!link) continue;
    if (outgoing[link.origin_id]) outgoing[link.origin_id].push(link.target_id);
    if (incoming[link.target_id]) incoming[link.target_id].push(link.origin_id);
  }

  // Topological layers
  const layers = [];
  const assigned = new Set();
  const inDeg = {};
  lgNodes.forEach(n => { inDeg[n.id] = (incoming[n.id] || []).length; });

  let queue = lgNodes.filter(n => inDeg[n.id] === 0).map(n => n.id);
  while (queue.length > 0) {
    layers.push([...queue]);
    queue.forEach(id => assigned.add(id));
    const next = [];
    queue.forEach(id => {
      (outgoing[id] || []).forEach(tid => {
        inDeg[tid]--;
        if (inDeg[tid] === 0 && !assigned.has(tid)) next.push(tid);
      });
    });
    queue = next;
  }

  // Assign unassigned
  lgNodes.forEach(n => {
    if (!assigned.has(n.id)) {
      if (layers.length === 0) layers.push([]);
      layers[layers.length - 1].push(n.id);
    }
  });

  // Position
  const layerWidth = 300;
  const nodeSpacing = 120;

  layers.forEach((layer, li) => {
    layer.forEach((nid, ni) => {
      const node = graph.getNodeById(nid);
      if (node) {
        node.pos = [60 + li * layerWidth, 60 + ni * nodeSpacing];
      }
    });
  });

  if (WFState.graphCanvas) {
    WFState.graphCanvas.setDirty(true, true);
    setTimeout(() => WFState.graphCanvas.centerOnGraph(), 50);
  }
};

// ─────────────────────────────────────────────
// WebSocket handlers
// ─────────────────────────────────────────────
WF.onWorkflowUpdate = function(data) {
  if (!WFState.current || WFState.current.id !== data.id) return;
  WFState.current.status = data.status;
  if (data.nodes) {
    data.nodes.forEach(updated => {
      updateNodeStatus(updated.id, updated.status);
    });
  }
  updateToolbar();
  if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
};

WF.onNodeUpdate = function(data) {
  if (!WFState.current) return;
  updateNodeStatus(data.node_id, data.status, data.result);
  if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
};

function updateNodeStatus(alchemyNodeId, status, result) {
  const graph = WFState.graph;
  if (!graph) return;

  const lgId = WFState.alchemyToLG[alchemyNodeId];
  if (lgId == null) return;

  const lgNode = graph.getNodeById(lgId);
  if (!lgNode) return;

  applyStatusToNode(lgNode, status);
  if (result) lgNode.alchemy_run_data = result;
}

// ─────────────────────────────────────────────
// Workflow Runs
// ─────────────────────────────────────────────
WF.loadRuns = async function() {
  if (!WFState.current) return;
  try {
    WFState.runs = await api(`/api/workflows/${WFState.current.id}/runs`);
  } catch (e) {
    WFState.runs = [];
  }
  WF.renderRunsList();
};

WF.renderRunsList = function() {
  const section = document.getElementById('wf-runs-section');
  const list = document.getElementById('wf-runs-list');
  const countEl = document.getElementById('wf-runs-count');
  const runs = WFState.runs || [];

  if (runs.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = '';
  countEl.textContent = `(${runs.length})`;

  if (!WFState.runsExpanded) {
    list.style.display = 'none';
    document.getElementById('wf-runs-toggle').textContent = '\u25B6';
    return;
  }

  list.style.display = '';
  document.getElementById('wf-runs-toggle').textContent = '\u25BC';

  list.innerHTML = runs.map(run => {
    const s = run.status || 'pending';
    const created = run.created_at ? new Date(run.created_at).toLocaleString() : '\u2014';
    let duration = '\u2014';
    if (run.started_at) {
      const start = new Date(run.started_at);
      const end = run.finished_at ? new Date(run.finished_at) : (s === 'running' ? new Date() : null);
      if (end) {
        const ms = end - start;
        const sec = Math.floor(ms / 1000);
        if (sec < 60) duration = sec + 's';
        else if (sec < 3600) duration = Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
        else duration = Math.floor(sec / 3600) + 'h ' + Math.floor((sec % 3600) / 60) + 'm';
      }
    }
    return `<div class="wf-run-item" onclick="WF.viewRun('${run.id}')">
      <span class="status-badge status-${s}" style="min-width:60px;text-align:center">${s}</span>
      <span style="flex:1;color:var(--text-muted);font-size:11px">${created}</span>
      <span style="color:var(--text-dim);font-size:11px">${duration}</span>
    </div>`;
  }).join('');
};

WF.toggleRunsPanel = function() {
  WFState.runsExpanded = !WFState.runsExpanded;
  WF.renderRunsList();
};

// ─────────────────────────────────────────────
// Run View Mode
// ─────────────────────────────────────────────
WF.viewRun = async function(runId) {
  if (!WFState.current) return;
  try {
    const run = await api(`/api/workflows/${WFState.current.id}/runs/${runId}`);
    WFState.currentRun = run;
    WFState.runViewMode = true;

    // Apply node statuses from run
    if (run.nodes && Array.isArray(run.nodes)) {
      run.nodes.forEach(rn => {
        const nodeId = rn.node_id || rn.id;
        updateNodeStatus(nodeId, rn.status || 'pending');
        // Store run data on the lg node
        const lgId = WFState.alchemyToLG[nodeId];
        if (lgId != null) {
          const lgNode = WFState.graph?.getNodeById(lgId);
          if (lgNode) lgNode.alchemy_run_data = rn;
        }
      });
    }

    // Make graph read-only
    if (WFState.graphCanvas) {
      WFState.graphCanvas.allow_dragnodes = false;
      WFState.graphCanvas.allow_interaction = true; // keep click for node selection
      WFState.graphCanvas.allow_searchbox = false;
      WFState.graphCanvas.read_only = true;
    }

    // Set up node click handler for run view
    if (WFState.graphCanvas) {
      WFState.graphCanvas.onNodeSelected = function(node) {
        showRunNodeProps(node);
      };
      WFState.graphCanvas.onBackgroundClick = function() {
        hideProps();
      };
    }

    updateToolbar();
    if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
  } catch (e) {
    toast('Failed to load run: ' + e.message, 'err');
  }
};

WF.exitRunView = function() {
  if (!WFState.runViewMode) return;
  WFState.runViewMode = false;
  WFState.currentRun = null;

  // Restore node statuses to pending
  const graph = WFState.graph;
  if (graph) {
    for (const lgNode of (graph._nodes || [])) {
      applyStatusToNode(lgNode, 'pending');
      lgNode.alchemy_run_data = null;
    }
  }

  // Restore interaction
  if (WFState.graphCanvas) {
    WFState.graphCanvas.allow_dragnodes = true;
    WFState.graphCanvas.allow_searchbox = true;
    WFState.graphCanvas.read_only = false;
    WFState.graphCanvas.onNodeSelected = null;
    WFState.graphCanvas.onBackgroundClick = null;
  }

  hideProps();
  updateToolbar();
  if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
};

WF.retryRun = async function() {
  if (!WFState.current || !WFState.currentRun) return;
  try {
    await api(`/api/workflows/${WFState.current.id}/runs/${WFState.currentRun.id}/retry`, {
      method: 'POST', body: '{}',
    });
    toast('Retry started', 'ok');
    WF.loadRuns();
  } catch (e) {
    toast('Retry failed: ' + e.message, 'err');
  }
};

// ─────────────────────────────────────────────
// Run View — Properties Side Panel
// ─────────────────────────────────────────────
function showRunNodeProps(lgNode) {
  if (!lgNode) return;
  const rd = lgNode.alchemy_run_data || {};
  const status = lgNode.alchemy_status || 'pending';
  const def = NODE_DEFS[lgNode.alchemy_type];

  const panel = document.getElementById('wf-props');
  const body = document.getElementById('wf-props-body');
  panel.style.display = '';

  const dotColors = {
    pending: '#94a3b8', ready: '#94a3b8', running: '#3b82f6',
    completed: '#22c55e', failed: '#ef4444', skipped: '#eab308',
  };
  const statusColor = dotColors[status] || '#94a3b8';

  let html = `
    <div class="form-group">
      <label class="form-label">Node</label>
      <div class="modal-value">${escHtml(lgNode.title || (def ? def.label : ''))}</div>
    </div>
    <div class="form-group">
      <label class="form-label">Status</label>
      <div class="modal-value" style="color:${statusColor}">${status}</div>
    </div>
  `;

  if (rd.exit_code != null) {
    html += `<div class="form-group">
      <label class="form-label">Exit Code</label>
      <div class="modal-value" style="color:${rd.exit_code === 0 ? 'var(--success)' : 'var(--error)'}">${rd.exit_code}</div>
    </div>`;
  }

  if (rd.error) {
    html += `<div class="form-group">
      <label class="form-label">Error</label>
      <div class="modal-value" style="color:var(--error);word-break:break-all">${escHtml(rd.error)}</div>
    </div>`;
  }

  if (rd.started_at) {
    html += `<div class="form-group">
      <label class="form-label">Started</label>
      <div class="modal-value">${new Date(rd.started_at).toLocaleString()}</div>
    </div>`;
  }

  if (rd.finished_at) {
    html += `<div class="form-group">
      <label class="form-label">Finished</label>
      <div class="modal-value">${new Date(rd.finished_at).toLocaleString()}</div>
    </div>`;
  }

  // Log viewer
  const logs = rd.log_buffer || rd.logs || [];
  html += `
    <hr style="border-color:var(--border);margin:8px 0">
    <div class="form-label" style="margin-bottom:4px">Logs</div>
    <div class="wf-node-log-viewer" id="wf-run-node-log">
  `;

  if (logs.length > 0) {
    logs.forEach(line => {
      const isErr = (typeof line === 'string') && (line.includes('Error') || line.includes('error') || line.startsWith('Traceback'));
      html += `<div class="log-line${isErr ? ' log-err' : ''}">${escHtml(line)}</div>`;
    });
  } else {
    html += '<span style="color:var(--text-dim)">No logs</span>';
  }

  if (rd.exit_code != null && rd.exit_code !== 0) {
    html += `<div class="log-exit-err">Exit code: ${rd.exit_code}${rd.error ? ' \u2014 ' + escHtml(rd.error) : ''}</div>`;
  }

  html += '</div>';
  body.innerHTML = html;

  // Auto-scroll log viewer
  const logEl = document.getElementById('wf-run-node-log');
  if (logEl) logEl.scrollTop = logEl.scrollHeight;

  // Resize canvas to account for props panel
  if (WFState._resizeHandler) WFState._resizeHandler();
}

function hideProps() {
  const panel = document.getElementById('wf-props');
  if (panel) panel.style.display = 'none';
  // Resize canvas back
  if (WFState._resizeHandler) WFState._resizeHandler();
}

// ─────────────────────────────────────────────
// Run View — WebSocket handlers
// ─────────────────────────────────────────────
WF.onRunUpdate = function(data) {
  if (!WFState.current) return;

  const idx = WFState.runs.findIndex(r => r.id === data.id);
  if (idx !== -1) {
    WFState.runs[idx] = { ...WFState.runs[idx], ...data };
  }
  WF.renderRunsList();

  if (WFState.currentRun && WFState.currentRun.id === data.id) {
    WFState.currentRun = { ...WFState.currentRun, ...data };
    updateToolbar();
  }
};

WF.onRunNodeUpdate = function(data) {
  if (!WFState.runViewMode || !WFState.currentRun) return;
  if (data.run_id && data.run_id !== WFState.currentRun.id) return;

  const nodeId = data.node_id;
  updateNodeStatus(nodeId, data.status);

  // Update run data on the lg node
  const lgId = WFState.alchemyToLG[nodeId];
  if (lgId != null && WFState.graph) {
    const lgNode = WFState.graph.getNodeById(lgId);
    if (lgNode) {
      if (!lgNode.alchemy_run_data) lgNode.alchemy_run_data = {};
      Object.assign(lgNode.alchemy_run_data, data);

      // Update props panel if this node is currently shown
      const panel = document.getElementById('wf-props');
      if (panel && panel.style.display !== 'none') {
        // Check if this node is selected
        if (WFState.graphCanvas && WFState.graphCanvas.selected_nodes) {
          const selected = Object.values(WFState.graphCanvas.selected_nodes);
          if (selected.includes(lgNode)) {
            showRunNodeProps(lgNode);
          }
        }
      }
    }
  }

  if (WFState.graphCanvas) WFState.graphCanvas.setDirty(true, true);
};

// ─────────────────────────────────────────────
// Node label update (for compatibility)
// ─────────────────────────────────────────────
WF.updateNodeLabel = function(nodeId, value) {
  // No-op, handled by litegraph title editing
};

WF.updateNodeConfig = function(nodeId, key, value) {
  // No-op, handled by litegraph widgets
};

WF.removeSelectedNode = function() {
  // No-op, handled by litegraph right-click menu
};

// ─────────────────────────────────────────────
// Initialize on DOM ready
// ─────────────────────────────────────────────
(function init() {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();

function onReady() {
  initLitegraphTheme();
  registerNodeTypes();
}
