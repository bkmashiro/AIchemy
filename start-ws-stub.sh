#!/bin/bash
NODE_NAME=$(hostname)
source ~/alchemy-v2/venv/bin/activate
exec python -m alchemy_stub     --server wss://alchemy-v2.yuzhes.com/stubs     --token alchemy-v2-token     --max-concurrent 1     --tags rtx4080,workstation     --default-cwd /vol/bitbucket/ys25/jema     --env-setup 'export PATH=/vol/bitbucket/ys25/conda-envs/jema/bin:$PATH && export PYTHONPATH=/vol/bitbucket/ys25/jema:$PYTHONPATH && export TORCH_HOME=/vol/bitbucket/ys25/.cache/torch && export HF_HOME=/vol/bitbucket/ys25/hf && cd /vol/bitbucket/ys25/jema'
