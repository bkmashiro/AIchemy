#!/usr/bin/env bash
# Alchemy v2 stub deployment: sync code → install → restart all stubs
# Usage: ./deploy-stubs.sh [--skip-slurm] [--skip-workstation]
set -e
cd "$(dirname "$0")"

CLUSTER="gpucluster2"
REMOTE_STUB="/vol/bitbucket/ys25/alchemy-v2/stub"
REMOTE_SDK="/vol/bitbucket/ys25/alchemy-v2/sdk"
CONDA_PIP="/vol/bitbucket/ys25/conda-envs/jema/bin/pip"
VENV_PIP="/homes/ys25/alchemy-v2/venv/bin/pip"
SBATCH_DIR="/vol/bitbucket/ys25/jema"

# Workstation stubs (direct SSH)
WORKSTATION_NODES="gpu32 gpu33"
WS_TOKEN="alchemy-v2-token"
WS_MAX_CONCURRENT=2
WS_TAGS="rtx4080,workstation"

# SLURM sbatch scripts
SLURM_SCRIPTS="sbatch_alchemy_a100.sh sbatch_alchemy_a30.sh sbatch_alchemy_a40.sh"

SKIP_SLURM=false
SKIP_WS=false
for arg in "$@"; do
  case $arg in
    --skip-slurm) SKIP_SLURM=true ;;
    --skip-workstation) SKIP_WS=true ;;
  esac
done

# ─── 1. Sync code ────────────────────────────────────────────────────────────

echo "==> Syncing stub + SDK to cluster..."
tar czf /tmp/alchemy-stub-deploy.tar.gz stub/ sdk/
scp -q /tmp/alchemy-stub-deploy.tar.gz "${CLUSTER}:/tmp/"
ssh "$CLUSTER" "cd /vol/bitbucket/ys25/alchemy-v2 && tar xzf /tmp/alchemy-stub-deploy.tar.gz && rm /tmp/alchemy-stub-deploy.tar.gz"
rm /tmp/alchemy-stub-deploy.tar.gz
echo "    ✓ Code synced"

# ─── 2. Install into both envs ───────────────────────────────────────────────

echo "==> Installing alchemy-stub..."
ssh "$CLUSTER" "$CONDA_PIP install -q -e $REMOTE_STUB 2>&1 | tail -1"
ssh "$CLUSTER" "$VENV_PIP install -q -e $REMOTE_STUB 2>&1 | tail -1"
echo "    ✓ Installed (conda + venv)"

# ─── 3. Restart workstation stubs ─────────────────────────────────────────────

if [ "$SKIP_WS" = false ]; then
  echo "==> Restarting workstation stubs..."
  for node in $WORKSTATION_NODES; do
    echo -n "    $node: "
    # Kill old process (avoid pkill matching SSH command)
    ssh "$CLUSTER" "ssh $node 'ps aux | grep \"python.*alchemy_stub\" | grep -v grep | awk \"{print \\\$2}\" | xargs kill 2>/dev/null || true'" 2>/dev/null
    sleep 1
    # Start new
    ssh "$CLUSTER" "ssh $node 'nohup bash /vol/bitbucket/ys25/alchemy-v2/start-ws-stub.sh > ~/alchemy-v2/stub-\$(hostname).log 2>&1 &'" 2>/dev/null
    echo "restarted"
  done
fi

# ─── 4. Restart SLURM stubs ──────────────────────────────────────────────────

if [ "$SKIP_SLURM" = false ]; then
  echo "==> Restarting SLURM stubs..."
  # Get current alchemy stub jobs
  JOBS=$(ssh "$CLUSTER" "squeue -u ys25 -h -o '%i %j' | grep train_ct | awk '{print \$1}'" 2>/dev/null || true)
  if [ -n "$JOBS" ]; then
    echo "    Cancelling: $JOBS"
    ssh "$CLUSTER" "scancel $JOBS"
    sleep 2
  fi
  # Resubmit
  for script in $SLURM_SCRIPTS; do
    echo -n "    $script: "
    JOB=$(ssh "$CLUSTER" "sbatch ${SBATCH_DIR}/${script} 2>&1 | grep -oP '\\d+'")
    echo "submitted ($JOB)"
  done
fi

# ─── 5. Verify ───────────────────────────────────────────────────────────────

echo ""
echo "==> Waiting 15s for stubs to connect..."
sleep 15

echo "==> Checking stub status..."
STUBS=$(NO_PROXY="*" curl -s -H "Authorization: Bearer alchemy-v2-token" http://localhost:3002/api/stubs 2>/dev/null || echo "[]")
ONLINE=$(echo "$STUBS" | python3 -c "import sys,json; print(len([s for s in json.load(sys.stdin) if s['status']=='online']))" 2>/dev/null || echo "?")
TOTAL=$(echo "$STUBS" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "?")
echo "    Stubs online: $ONLINE / $TOTAL"
echo ""
echo "Done."
