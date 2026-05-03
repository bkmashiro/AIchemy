# Alchemy-v2 Smoke/Integration Test System — Design Document

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        test runner (pytest)                      │
│  • starts test server process                                    │
│  • spawns stub processes (real alchemy_stub, pointed at test)    │
│  • submits tasks via REST API                                    │
│  • polls task status, asserts outcomes                           │
│  • collects structured logs                                      │
│  • tears everything down                                         │
│  • produces JSONL report                                         │
└──────────┬──────────────┬──────────────────┬────────────────────┘
           │              │                  │
     ┌─────▼─────┐  ┌────▼────┐       ┌─────▼──────┐
     │ test server│  │ stub-A  │       │ stub-B … N │
     │ port 13002 │◄─┤ real    │       │ Docker or  │
     │ STATE_FILE │  │ process │       │ local proc │
     │ = tmpdir/  │  └─────────┘       └────────────┘
     │ state.json │
     └────────────┘
```

### Key principles

- **Full isolation.** Test server runs on a dedicated port (default `13002`) with its own `STATE_FILE` in a temporary directory. Zero interaction with production.
- **Real components.** Server = the real `tsx src/index.ts` (or `node dist/index.js`). Stubs = real `python -m alchemy_stub`. No mocking of the transport layer — we test the actual socket.io path.
- **Docker only for permission/env simulation.** The basic test suite runs locally (no Docker needed). Docker containers are used exclusively for heterogeneous-environment scenarios (wrong Python, no nvidia-smi, permission denied).
- **pytest as orchestrator.** Python is already a dependency (stubs, SDK). pytest gives fixtures, parametrize, timeouts, xdist parallelism, and readable assertions.

---

## 2. Directory Structure

```
smoke-tests/
├── DESIGN.md                   # this file
├── README.md                   # updated usage docs
├── conftest.py                 # pytest fixtures: server, stubs, api client
├── pytest.ini                  # pytest config (timeouts, markers)
├── requirements.txt            # httpx, pytest, pytest-timeout, pytest-asyncio
│
├── harness/
│   ├── __init__.py
│   ├── server.py               # TestServer: start/stop/health-check
│   ├── stub.py                 # TestStub: start real stub process against test server
│   ├── api.py                  # ApiClient: thin wrapper around REST endpoints
│   ├── waiter.py               # poll_until(predicate, timeout) helpers
│   ├── docker.py               # Docker container helpers (heterogeneous stubs)
│   └── report.py               # structured JSONL report writer
│
├── scripts/                    # existing task scripts (unchanged)
│   ├── success_fast.sh
│   ├── fail_exit1.sh
│   └── ...
│
├── tasks.json                  # existing task definitions (kept for run_smoke.sh compat)
├── run_smoke.sh                # existing quick submitter (kept, unchanged)
│
├── tests/
│   ├── test_lifecycle.py       # submit→dispatch→complete/fail basic lifecycle
│   ├── test_failure.py         # exit codes, OOM, preflight failures
│   ├── test_resume.py          # checkpoint/resume flows
│   ├── test_signal.py          # graceful shutdown, SIGTERM handling
│   ├── test_disk.py            # tmp writes, cleanup verification
│   ├── test_scheduling.py      # priority, tags, multi-stub dispatch
│   ├── test_sdk.py             # SDK progress/metrics reporting
│   ├── test_concurrency.py     # max_concurrent enforcement, slot contention
│   ├── test_dedup.py           # fingerprint dedup, idempotency keys
│   ├── test_preflight.py       # cwd missing, script not found, run_dir locked
│   └── test_heterogeneous.py   # Docker-based: permissions, missing deps
│
└── docker/
    ├── Dockerfile.stub-base    # minimal Python 3.12 + alchemy_stub
    ├── Dockerfile.stub-noperm  # runs as nobody, restricted /tmp
    ├── Dockerfile.stub-oldpy   # Python 3.8 (below 3.10 minimum)
    ├── Dockerfile.stub-nogpu   # no nvidia-smi binary at all
    └── docker-compose.test.yml # orchestrates test server + N heterogeneous stubs
```

---

## 3. Test Harness Components

### 3.1 TestServer (`harness/server.py`)

```python
class TestServer:
    """Manages a test-isolated alchemy-v2 server process."""

    def __init__(self, port=13002, server_dir="server/"):
        self.port = port
        self.state_dir = tempfile.mkdtemp(prefix="alchemy_test_")
        self.state_file = os.path.join(self.state_dir, "state.json")
        self.token = f"test-token-{uuid4().hex[:8]}"
        self.proc = None

    def start(self):
        """Start server with: PORT=13002 STATE_FILE=/tmp/.../state.json ALCHEMY_TOKEN=..."""
        env = {
            **os.environ,
            "PORT": str(self.port),
            "STATE_FILE": self.state_file,
            "ALCHEMY_TOKEN": self.token,
            "NODE_ENV": "test",
        }
        self.proc = subprocess.Popen(
            ["npx", "tsx", "src/index.ts"],
            cwd=server_dir, env=env,
            stdout=open(f"{self.state_dir}/server.log", "w"),
            stderr=subprocess.STDOUT,
        )
        self._wait_healthy(timeout=15)

    def _wait_healthy(self, timeout):
        """Poll GET /api/health until 200 or timeout."""

    def stop(self):
        """SIGTERM → wait 5s → SIGKILL. Copy logs to report dir."""

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"
```

### 3.2 TestStub (`harness/stub.py`)

```python
class TestStub:
    """Manages a real alchemy_stub process pointed at the test server."""

    def __init__(self, server_url, token, name, tags=None, max_concurrent=3):
        self.server_url = server_url
        self.token = token
        self.name = name
        self.tags = tags or []
        self.max_concurrent = max_concurrent

    def start(self):
        """python -m alchemy_stub --server URL --token TOKEN --tags ... --max-concurrent N"""
        # Override ALCHEMY_LOG_DIR to test tmpdir
        # Set unique --default-cwd per stub

    def stop(self):
        """SIGTERM → graceful drain → SIGKILL fallback."""

    def wait_online(self, api_client, timeout=15):
        """Poll GET /api/stubs until this stub appears with status=online."""
```

### 3.3 ApiClient (`harness/api.py`)

Thin `httpx` wrapper. Key methods:

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `submit(script, **kwargs)` | `POST /api/tasks` | Submit task, return task dict |
| `get_task(id)` | `GET /api/tasks/:id` | Fetch current task state |
| `list_tasks(**filters)` | `GET /api/tasks` | Paginated listing |
| `kill_task(id)` | `PATCH /api/tasks/:id` | Set status=killed |
| `batch(action, ids)` | `POST /api/tasks/batch` | Batch operations |
| `list_stubs()` | `GET /api/stubs` | All stubs |
| `health()` | `GET /api/health` | Health check |

### 3.4 Waiter (`harness/waiter.py`)

```python
def wait_for_status(api, task_id, target_statuses, timeout=60, poll_interval=1.0):
    """Poll task until status in target_statuses. Return final task dict or raise TimeoutError."""

def wait_all_terminal(api, task_ids, timeout=120):
    """Wait until all tasks reach a terminal status."""
```

### 3.5 Report Writer (`harness/report.py`)

Writes a JSONL file + final summary table to both file and stdout.

```python
@dataclass
class TestResult:
    scenario: str           # e.g. "lifecycle.success_fast"
    passed: bool
    task_id: str | None
    expected_status: str
    actual_status: str
    expected_exit_code: int | None
    actual_exit_code: int | None
    duration_s: float
    error: str | None       # assertion failure message
    log_snippet: str        # first 500 chars of task log

class ReportWriter:
    def __init__(self, output_dir):
        self.jsonl_path = f"{output_dir}/results.jsonl"
        self.results: list[TestResult] = []

    def record(self, result: TestResult): ...
    def finalize(self) -> str:
        """Print pass/fail table, return exit code 0/1."""
```

---

## 4. Test Scenarios

### 4.1 Lifecycle Tests (`test_lifecycle.py`)

| Scenario | Task | Assertion |
|----------|------|-----------|
| Fast success | `success_fast.sh` | status=completed, exit_code=0, duration < 10s |
| Slow success | `success_slow.sh` | status=completed, exit_code=0, 25s < duration < 45s |
| Multi-tag dispatch | `multi_tag.sh` | status=completed, dispatched to stub with matching tags |
| Task shows in API listing | any | `GET /api/tasks?status=running` returns the task while running |
| Completion moves to terminal | any success | task no longer in `running` status after exit |

### 4.2 Failure Tests (`test_failure.py`)

| Scenario | Task | Assertion |
|----------|------|-----------|
| Exit code 1 | `fail_exit1.sh` | status=failed, exit_code=1 |
| OOM simulation | `fail_oom.py` | status=failed, exit_code != 0 |
| Nonexistent script | `python3 /does/not/exist.py` | status=failed, preflight error in log_buffer |
| Missing cwd | task with `cwd=/nonexistent` | status=failed, preflight "does not exist" |

### 4.3 Resume Tests (`test_resume.py`)

| Scenario | Steps | Assertion |
|----------|-------|-----------|
| Fresh run | Submit `checkpoint_resume.sh` with unique SMOKE_CKPT_DIR | completed, checkpoint file created |
| Resume run | Re-submit same task (new SMOKE_CKPT_DIR pointing to same dir) | completed, log contains "resuming from step 100" |
| Clean state | Delete checkpoint dir between runs | log contains "no checkpoint — fresh run" |

Implementation: each test gets a unique tmpdir for `SMOKE_CKPT_DIR` via task `env`.

### 4.4 Signal Tests (`test_signal.py`)

| Scenario | Steps | Assertion |
|----------|-------|-----------|
| Graceful SIGTERM | Submit `signal_handler.sh`, wait for "running", then `PATCH status=killed` | status=killed, log contains "SIGTERM received" and "cleanup done" |
| Kill timeout | Submit a task that ignores SIGTERM (`trap '' SIGTERM; sleep 999`), kill it | status=killed (SIGKILL fallback) |

### 4.5 Disk Tests (`test_disk.py`)

| Scenario | Task | Assertion |
|----------|------|-----------|
| Write + cleanup | `writes_disk.sh` | status=completed, verify /tmp/smoke_io_* does NOT exist after completion |
| Large output | task writing to specific tmpdir | completed, verify files exist during run, gone after cleanup |

### 4.6 Scheduling Tests (`test_scheduling.py`)

Requires 2+ stubs.

| Scenario | Setup | Assertion |
|----------|-------|-----------|
| Tag routing | stub-A has tags=["gpu","a40"], stub-B has tags=["cpu"]. Submit task with target_tags=["gpu"] | task dispatched to stub-A |
| Priority ordering | Submit low-priority then high-priority task. 1 stub, max_concurrent=1, first task is slow | high-priority task runs before low-priority (or immediately after slot opens) |
| Max concurrent | 1 stub, max_concurrent=2. Submit 3 fast tasks | At most 2 running simultaneously; 3rd waits in queue |
| Load balancing | 2 identical stubs. Submit 4 tasks | Tasks spread across both stubs (not all on one) |

### 4.7 SDK Integration Tests (`test_sdk.py`)

New task script needed: `scripts/sdk_reporter.py`

```python
"""Task that uses the SDK to report progress and metrics."""
from alchemy_sdk import Alchemy
al = Alchemy()
for step in range(10):
    al.log(step, 10, loss=1.0/(step+1), metrics={"reward": step*0.1})
    time.sleep(1)
al.done()
```

| Scenario | Assertion |
|----------|-----------|
| Progress updates | task.progress.step reaches 9, loss decreases |
| Metrics visible | GET /api/tasks/:id shows progress field populated |
| should_stop | Submit, wait for running, PATCH should_stop=true → task exits cleanly via SDK |

### 4.8 Dedup Tests (`test_dedup.py`)

| Scenario | Steps | Assertion |
|----------|-------|-----------|
| Fingerprint dedup | Submit identical task twice | Second submission returns 409 with existing_task_id |
| Idempotency key | Submit with same idempotency_key twice | Second returns 200 (not 201), same task_id |
| Different params bypass dedup | Submit same script with different param_overrides | Both accepted (different fingerprints) |

### 4.9 Preflight Tests (`test_preflight.py`)

| Scenario | Task spec | Assertion |
|----------|-----------|-----------|
| cwd does not exist | `cwd: "/tmp/alchemy_test_nonexistent_abc"` | failed, log contains "does not exist" |
| Script not found | `script: "python3 /tmp/alchemy_no_such_script.py"` | failed, log contains "Script not found" |
| run_dir write lock | Submit task A with run_dir=X, then task B with same run_dir=X | Task B gets 409 "locked by task" |
| run_dir parent not writable | run_dir under /root/something (stub running as non-root) | failed, "not writable" |

### 4.10 Heterogeneous Stub Tests (`test_heterogeneous.py`)

Docker-based. Marked with `@pytest.mark.docker` (skipped unless `--docker` flag).

| Scenario | Container | Assertion |
|----------|-----------|-----------|
| Python too old | `stub-oldpy` (Python 3.8) | Stub process exits immediately, does not register |
| No nvidia-smi | `stub-nogpu` | Stub registers, GPU info is empty/null, tasks run in CPU mode |
| Permission denied on /tmp | `stub-noperm` (read-only /tmp) | Stub fails self-check ("tmp not writable"), does not register |
| Slow network | `stub-base` with `tc netem delay 500ms` | Stub registers (slower), heartbeats arrive, tasks complete (with higher latency) |
| Multiple competing stubs | 3x `stub-base` | Tasks distributed across stubs, all complete |

---

## 5. Docker Setup

### 5.1 `Dockerfile.stub-base`

```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY stub/ ./stub/
COPY sdk/ ./sdk/
RUN pip install --no-cache-dir ./sdk ./stub 2>/dev/null || \
    pip install --no-cache-dir aiohttp python-socketio[asyncio_client]
# The stub is run via: python -m alchemy_stub --server ... --token ...
ENTRYPOINT ["python", "-m", "alchemy_stub"]
```

### 5.2 `Dockerfile.stub-oldpy`

```dockerfile
FROM python:3.8-slim
# Same setup — stub will fail at _check_python_version() (requires >=3.10)
...
```

### 5.3 `Dockerfile.stub-noperm`

```dockerfile
FROM python:3.12-slim
# ... install stub ...
RUN useradd -m restricted
# Make /tmp read-only for this user
RUN chmod 555 /tmp
USER restricted
ENTRYPOINT ["python", "-m", "alchemy_stub"]
```

### 5.4 `docker-compose.test.yml`

```yaml
version: "3.9"
services:
  test-server:
    build:
      context: ../server
    ports:
      - "13002:13002"
    environment:
      PORT: "13002"
      STATE_FILE: /tmp/test-state.json
      ALCHEMY_TOKEN: test-token
    tmpfs:
      - /tmp

  stub-normal:
    build:
      context: ..
      dockerfile: smoke-tests/docker/Dockerfile.stub-base
    command: ["--server", "http://test-server:13002", "--token", "test-token", "--tags", "normal"]
    depends_on: [test-server]

  stub-nogpu:
    build:
      context: ..
      dockerfile: smoke-tests/docker/Dockerfile.stub-nogpu
    command: ["--server", "http://test-server:13002", "--token", "test-token", "--tags", "nogpu"]
    depends_on: [test-server]

  stub-oldpy:
    build:
      context: ..
      dockerfile: smoke-tests/docker/Dockerfile.stub-oldpy
    command: ["--server", "http://test-server:13002", "--token", "test-token"]
    depends_on: [test-server]

  stub-noperm:
    build:
      context: ..
      dockerfile: smoke-tests/docker/Dockerfile.stub-noperm
    command: ["--server", "http://test-server:13002", "--token", "test-token"]
    depends_on: [test-server]

  stub-slow:
    build:
      context: ..
      dockerfile: smoke-tests/docker/Dockerfile.stub-base
    command: ["--server", "http://test-server:13002", "--token", "test-token", "--tags", "slow-net"]
    cap_add: [NET_ADMIN]  # for tc netem
    depends_on: [test-server]
    # Network delay injected via entrypoint wrapper: tc qdisc add dev eth0 root netem delay 500ms
```

---

## 6. pytest Fixtures (`conftest.py`)

```python
@pytest.fixture(scope="session")
def test_server():
    """Start a test server for the entire pytest session."""
    srv = TestServer(port=13002)
    srv.start()
    yield srv
    srv.stop()

@pytest.fixture(scope="session")
def api(test_server):
    """API client pointed at the test server."""
    return ApiClient(test_server.url, test_server.token)

@pytest.fixture(scope="session")
def stub_default(test_server):
    """One default stub, online for the session."""
    s = TestStub(test_server.url, test_server.token, name="test-stub-default", max_concurrent=5)
    s.start()
    yield s
    s.stop()

@pytest.fixture
def stub_factory(test_server):
    """Factory for creating additional stubs per-test."""
    stubs = []
    def _make(name, tags=None, max_concurrent=3):
        s = TestStub(test_server.url, test_server.token, name=name, tags=tags, max_concurrent=max_concurrent)
        s.start()
        stubs.append(s)
        return s
    yield _make
    for s in stubs:
        s.stop()

@pytest.fixture
def tmp_workdir(tmp_path):
    """Unique tmp directory usable as cwd/run_dir for a test."""
    d = tmp_path / "workdir"
    d.mkdir()
    return str(d)
```

---

## 7. Structured Logging Format

All test infrastructure writes JSONL to `{report_dir}/test_run.jsonl`.

### Log entry schema

```json
{
  "ts": "2026-04-26T10:00:00.123Z",
  "level": "info|warn|error",
  "component": "server|stub|runner|assertion",
  "event": "server.start|stub.online|task.submitted|task.terminal|assertion.pass|assertion.fail",
  "task_id": "uuid or null",
  "stub_name": "test-stub-default or null",
  "detail": {
    "status": "completed",
    "exit_code": 0,
    "duration_s": 3.2,
    "expected": "completed",
    "actual": "completed",
    "log_head": "first 500 chars of task output..."
  }
}
```

### Server/stub process logs

Captured to `{report_dir}/server.log` and `{report_dir}/stub-{name}.log`. These are raw process stdout/stderr, not structured — used for post-mortem only.

---

## 8. Result Report

Final output at `{report_dir}/summary.txt` and printed to stdout.

```
╔══════════════════════════════════╦════════╦══════════════╦═════════╗
║ Scenario                         ║ Status ║ Exit Code    ║ Time    ║
╠══════════════════════════════════╬════════╬══════════════╬═════════╣
║ lifecycle.success_fast           ║ PASS   ║ 0 (exp: 0)   ║ 3.1s   ║
║ lifecycle.success_slow           ║ PASS   ║ 0 (exp: 0)   ║ 31.2s  ║
║ failure.exit1                    ║ PASS   ║ 1 (exp: 1)   ║ 2.3s   ║
║ failure.oom                      ║ PASS   ║ 1 (exp: !=0) ║ 8.5s   ║
║ resume.fresh_then_resume         ║ PASS   ║ 0 (exp: 0)   ║ 6.1s   ║
║ signal.graceful_sigterm          ║ PASS   ║ 0 (exp: 0)   ║ 4.2s   ║
║ preflight.cwd_missing            ║ PASS   ║ -1 (exp:-1)  ║ 0.8s   ║
║ scheduling.tag_routing           ║ PASS   ║ 0 (exp: 0)   ║ 5.3s   ║
║ heterogeneous.old_python         ║ PASS   ║ N/A          ║ 1.2s   ║
╠══════════════════════════════════╬════════╬══════════════╬═════════╣
║ TOTAL: 22/22 passed              ║        ║              ║ 94.1s  ║
╚══════════════════════════════════╩════════╩══════════════╩═════════╝
```

---

## 9. CI Integration

### GitHub Actions workflow (`.github/workflows/smoke-tests.yml`)

```yaml
name: Smoke Tests
on:
  push:
    paths: ["server/**", "stub/**", "sdk/**", "smoke-tests/**"]
  pull_request:
    paths: ["server/**", "stub/**", "sdk/**", "smoke-tests/**"]
  workflow_dispatch:

jobs:
  smoke-basic:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }

      - name: Install server deps
        run: cd server && npm ci

      - name: Install test deps
        run: |
          pip install -r smoke-tests/requirements.txt
          pip install ./sdk
          pip install ./stub  # or: pip install aiohttp python-socketio[asyncio_client]

      - name: Run smoke tests (no Docker)
        run: |
          cd smoke-tests
          pytest tests/ -v --timeout=120 -m "not docker" --tb=short \
            --junitxml=results/junit.xml
        env:
          ALCHEMY_TEST_PORT: 13002

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: smoke-test-results
          path: smoke-tests/results/

  smoke-docker:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    needs: smoke-basic
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }

      - name: Build test images
        run: cd smoke-tests && docker compose -f docker/docker-compose.test.yml build

      - name: Run heterogeneous tests
        run: |
          pip install -r smoke-tests/requirements.txt
          cd smoke-tests
          pytest tests/test_heterogeneous.py -v --timeout=180 -m docker --tb=short
```

### Local execution

```bash
# Quick run — no Docker
cd smoke-tests
pip install -r requirements.txt
pytest tests/ -v -m "not docker" --timeout=120

# Full run — with Docker heterogeneous tests
pytest tests/ -v --timeout=180

# Single scenario
pytest tests/test_lifecycle.py::test_success_fast -v
```

---

## 10. Implementation Phases

### Phase 1 — Core harness (1-2 days)

- `harness/server.py` — TestServer start/stop/health
- `harness/stub.py` — TestStub start/stop/wait_online
- `harness/api.py` — ApiClient
- `harness/waiter.py` — poll helpers
- `conftest.py` — session fixtures
- `tests/test_lifecycle.py` — success_fast, success_slow, fail_exit1

This alone replaces the current `run_smoke.sh` with assertions.

### Phase 2 — Full scenario coverage (2-3 days)

- `test_failure.py` — OOM, preflight failures
- `test_resume.py` — checkpoint/resume
- `test_signal.py` — SIGTERM handling
- `test_disk.py` — write/cleanup verification
- `test_dedup.py` — fingerprint, idempotency
- `test_preflight.py` — cwd/script/run_dir checks
- `harness/report.py` — structured JSONL + summary table

### Phase 3 — Multi-stub scheduling (1-2 days)

- `test_scheduling.py` — tag routing, priority, load balancing
- `test_concurrency.py` — max_concurrent enforcement
- `test_sdk.py` — SDK progress reporting (requires `scripts/sdk_reporter.py`)

### Phase 4 — Docker heterogeneous (2-3 days)

- Dockerfiles
- `docker-compose.test.yml`
- `harness/docker.py` — container lifecycle helpers
- `test_heterogeneous.py` — old Python, no GPU, permissions, slow network
- CI workflow

### Phase 5 — CI + polish (1 day)

- GitHub Actions workflow
- `requirements.txt` finalization
- README update
- Timeout tuning

---

## 11. Configuration

All configurable via environment variables (no config files needed):

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALCHEMY_TEST_PORT` | `13002` | Test server port |
| `ALCHEMY_TEST_SERVER_DIR` | `../server` | Path to server source |
| `ALCHEMY_TEST_STUB_DIR` | `../stub` | Path to stub source |
| `ALCHEMY_TEST_SCRIPTS_DIR` | `./scripts` | Path to task scripts |
| `ALCHEMY_TEST_REPORT_DIR` | `/tmp/alchemy_test_results` | Output dir for logs/reports |
| `ALCHEMY_TEST_TIMEOUT` | `120` | Default per-test timeout (seconds) |

---

## 12. Notes

**Why not vitest for everything?** The server already has vitest unit tests. This smoke suite tests the full stack (server + stub + subprocess + SDK). Python pytest is better suited because: (a) stubs are Python, (b) task scripts are Python/bash, (c) subprocess management is cleaner in Python, (d) Docker SDK is Python-native.

**Why real stubs, not mock stubs?** Mock stubs test the server but not the stub. The bugs we care about (preflight path resolution, process spawning, signal handling, socket reconnection) live in the stub. Real stubs catch real bugs.

**State cleanup between tests.** Each test that submits tasks should use unique task names/fingerprints (via UUID suffix) to avoid dedup collisions. The session-scoped server accumulates state across tests — this is intentional (tests should be independent via unique identifiers, not via server resets). A `POST /cleanup` call at session end removes old archived tasks.
