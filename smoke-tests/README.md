# Alchemy v2 Smoke Tests

End-to-end task simulation suite. Exercises the full scheduler pipeline without real training jobs.

## Prerequisites

- **Node.js 20+** (for the test server)
- **Python 3.12+** (for stubs and test runner)
- **Docker + Docker Compose** (only for heterogeneous tests)

## Setup

```bash
cd /workspace/extra/projects/alchemy-v2

# Install server dependencies
cd server && npm ci && cd ..

# Install Python test dependencies
pip install -r smoke-tests/requirements.txt
pip install ./sdk ./stub
```

## Running Tests

### Local (no Docker)

```bash
cd smoke-tests

# Run all non-Docker tests
pytest tests/ -v -m "not docker" --timeout=120

# Run a single test file
pytest tests/test_lifecycle.py -v

# Run a single test
pytest tests/test_lifecycle.py::test_success_fast -v
```

### Docker heterogeneous tests

```bash
cd smoke-tests

# Build Docker images first
docker compose -f docker/docker-compose.test.yml build

# Run only Docker tests
pytest tests/test_heterogeneous.py -v -m docker --timeout=180

# Run all tests (local + Docker)
pytest tests/ -v --timeout=180
```

### CI

The GitHub Actions workflow (`.github/workflows/smoke-tests.yml`) runs automatically on push/PR when `server/`, `stub/`, `sdk/`, or `smoke-tests/` change. Two jobs:

1. **smoke-basic** — Runs all non-Docker tests on ubuntu-latest with Node 20 + Python 3.12.
2. **smoke-docker** — Builds Docker images and runs heterogeneous stub tests. Depends on smoke-basic passing first.

Test artifacts are uploaded on failure for debugging.

## Quick smoke (legacy)

```bash
cd smoke-tests
./run_smoke.sh          # submit all smoke tasks
./run_smoke.sh fast     # filter by name
```

Environment overrides:

```bash
ALCHEMY_SERVER=http://my-server:3002 ALCHEMY_TOKEN=my-token ./run_smoke.sh
```

## Test Markers

| Marker | Description |
|--------|-------------|
| `docker` | Requires Docker. Skipped by default with `-m "not docker"` |

## Docker Test Scenarios

| Scenario | Container | Expected behavior |
|----------|-----------|-------------------|
| Python too old | `stub-oldpy` (Python 3.8) | Exits immediately, does not register |
| No nvidia-smi | `stub-nogpu` | Registers with empty GPU info, CPU tasks run |
| Read-only /tmp | `stub-noperm` | Fails self-check, does not register |
| Slow network | `stub-slow` (tc netem 500ms) | Registers slower but works, tasks complete |
| Competing stubs | 3x `stub-compete-*` | Tasks distributed across all stubs |

## Configuration

All configurable via environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `ALCHEMY_TEST_PORT` | `13002` | Test server port |
| `ALCHEMY_TEST_SERVER_DIR` | `../server` | Path to server source |
| `ALCHEMY_TEST_STUB_DIR` | `../stub` | Path to stub source |
| `ALCHEMY_TEST_SCRIPTS_DIR` | `./scripts` | Path to task scripts |
| `ALCHEMY_TEST_REPORT_DIR` | `/tmp/alchemy_test_results` | Output dir for logs/reports |
| `ALCHEMY_TEST_TIMEOUT` | `120` | Default per-test timeout (seconds) |

## Task Scripts

| Name | Script | Expected outcome |
|---|---|---|
| `smoke_success_fast` | `success_fast.sh` | exits 0 in ~3s |
| `smoke_success_slow` | `success_slow.sh` | exits 0 in ~30s |
| `smoke_fail_exit1` | `fail_exit1.sh` | exits 1 after 2s |
| `smoke_fail_oom` | `fail_oom.py` | killed by OOM |
| `smoke_writes_disk` | `writes_disk.sh` | writes 50MB, cleans up |
| `smoke_checkpoint_resume` | `checkpoint_resume.sh` | writes checkpoint; re-run resumes |
| `smoke_signal_handler` | `signal_handler.sh` | SIGTERM cleanup |
