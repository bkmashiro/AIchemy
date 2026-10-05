"""Stdlib-only runtime/cgroup/CUDA identity probe, executed inside Slurm."""
from __future__ import annotations

import ctypes
import ctypes.util
import importlib.util
import json
import os
import platform
import socket
import subprocess
import sys
import uuid
from pathlib import Path


def probe() -> dict:
    keys = ['SLURM_JOB_ID', 'SLURM_STEP_ID', 'SLURM_JOB_NODELIST', 'SLURM_MEM_PER_NODE',
            'SLURM_CPUS_PER_TASK', 'SLURM_JOB_GPUS', 'SLURM_STEP_GPUS',
            'CUDA_VISIBLE_DEVICES', 'SLURM_GPUS_ON_NODE']
    result = {'hostname': socket.gethostname(), 'python': sys.version,
              'executable': sys.executable, 'platform': platform.platform(),
              'environment': {key: os.environ.get(key) for key in keys},
              'cpu_affinity': sorted(os.sched_getaffinity(0)),
              'interpreters': {str(p): p.exists() for p in
                               [Path('/usr/bin/python3.12'), Path('/usr/bin/python3.14')]}}
    for name in ['alchemy_sdk', 'alchemy_stub']:
        spec = importlib.util.find_spec(name)
        result[name] = spec.origin if spec else None
    command = ['nvidia-smi', '--query-gpu=index,uuid,name,memory.total,memory.used',
               '--format=csv,noheader,nounits']
    try:
        process = subprocess.run(command, capture_output=True, text=True, timeout=15)
        result['nvidia_smi'] = {'returncode': process.returncode, 'stdout': process.stdout,
                                'stderr': process.stderr}
    except Exception as error:
        result['nvidia_smi'] = {'error': str(error)}
    try:
        cuda = ctypes.CDLL(ctypes.util.find_library('cuda') or 'libcuda.so.1')
        status = cuda.cuInit(0)
        if status:
            raise RuntimeError(f'cuInit status={status}')
        count = ctypes.c_int()
        status = cuda.cuDeviceGetCount(ctypes.byref(count))
        if status:
            raise RuntimeError(f'cuDeviceGetCount status={status}')
        visible = []
        for ordinal in range(count.value):
            device = ctypes.c_int()
            status = cuda.cuDeviceGet(ctypes.byref(device), ordinal)
            if status:
                raise RuntimeError(f'cuDeviceGet status={status}')
            identity = (ctypes.c_ubyte * 16)()
            status = cuda.cuDeviceGetUuid(ctypes.byref(identity), device)
            if status:
                raise RuntimeError(f'cuDeviceGetUuid status={status}')
            visible.append({'ordinal': ordinal, 'uuid': 'GPU-' + str(uuid.UUID(bytes=bytes(identity)))})
        result['cuda_visible_devices'] = visible
    except Exception as error:
        result['cuda_visible_devices'] = {'error': str(error)}
    cgroup = Path('/proc/self/cgroup').read_text()
    result['cgroup_membership'] = cgroup
    membership = next((line.split(':', 2)[2] for line in cgroup.splitlines() if line.startswith('0::')), None)
    ancestors = []
    if membership:
        current = Path('/sys/fs/cgroup') / membership.lstrip('/')
        while current.is_relative_to(Path('/sys/fs/cgroup')):
            values = {'path': str(current)}
            for field in ['memory.max', 'memory.current', 'memory.events', 'cpu.max', 'cpuset.cpus.effective']:
                p = current / field
                if p.exists():
                    values[field] = p.read_text().strip()
            ancestors.append(values)
            if current == Path('/sys/fs/cgroup'):
                break
            current = current.parent
    result['cgroup_ancestors'] = ancestors
    limits = [int(x['memory.max']) for x in ancestors if x.get('memory.max', '').isdigit()]
    result['effective_memory_max_bytes'] = min(limits) if limits else None
    return result


if __name__ == '__main__':
    output = Path(sys.argv[1])
    result = probe()
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'hostname': result['hostname'],
                      'job_id': result['environment']['SLURM_JOB_ID']}))
