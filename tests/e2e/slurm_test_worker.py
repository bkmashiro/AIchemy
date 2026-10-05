"""Allocated Slurm worker: install isolated wheels, forward SSH, run daemon."""
from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import time
from pathlib import Path

import importlib.util


def runtime_probe():
    spec = importlib.util.spec_from_file_location('slurm_runtime_probe', Path(__file__).with_name('slurm_runtime_probe.py'))
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.probe()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    stage, runtime = Path(args.stage), Path(args.runtime)
    job_id = os.environ['SLURM_JOB_ID']
    port = 35000 + int(job_id) % 16000
    job = stage / ('job-' + job_id)
    job.mkdir(mode=0o700)
    processes = []
    try:
        (job / 'runtime-probe.json').write_text(json.dumps(runtime_probe(), indent=2))
        ready = stage / 'runtime-ready'
        if args.prepare:
            if runtime.exists():
                raise RuntimeError('refuse to overwrite existing runtime')
            subprocess.run(['/usr/bin/python3.12', '-m', 'venv', str(runtime)], check=True)
            subprocess.run([str(runtime / 'bin/python'), '-m', 'pip', 'install',
                            str(stage / 'alchemy_sdk-2.2.0-py3-none-any.whl'),
                            str(stage / 'alchemy_stub-2.2.0-py3-none-any.whl')], check=True, timeout=180)
            subprocess.run([str(runtime / 'bin/python'), '-m', 'pip', 'check'], check=True)
            ready.write_text(str(runtime))
        else:
            deadline = time.monotonic() + 210
            while not ready.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError('shared runtime did not become ready')
                time.sleep(2)
            if ready.read_text() != str(runtime):
                raise RuntimeError('runtime receipt mismatch')
        tunnel = subprocess.Popen([
            'ssh', '-F', '/dev/null', '-N', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'HostKeyAlgorithms=ssh-ed25519',
            '-o', 'UserKnownHostsFile=' + str(stage / 'login-known-hosts'),
            '-o', 'ConnectTimeout=12', '-o', 'ExitOnForwardFailure=yes',
            '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
            '-L', f'127.0.0.1:{port}:127.0.0.1:34228',
            'ys25@cloud-vm-40-244.doc.ic.ac.uk'],
            stdout=(job / 'ssh.log').open('w'), stderr=subprocess.STDOUT,
            start_new_session=True)
        processes.append(tunnel)
        # Both allocations can share one host. Give each loopback port a unique
        # allocation-specific value rather than competing for the same listener.
        # The shell caller passes no credentials; token is read privately here.
        from urllib.request import urlopen
        deadline = time.monotonic() + 25
        while True:
            if tunnel.poll() is not None:
                raise RuntimeError('compute-to-login SSH tunnel exited: ' + (job / 'ssh.log').read_text()[-1200:])
            try:
                with urlopen(f'http://127.0.0.1:{port}/api/health', timeout=2) as response:
                    if response.status == 200:
                        break
            except OSError:
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError('forwarded server unreachable')
            time.sleep(.5)
        token = (stage / 'token').read_text().strip()
        daemon = subprocess.Popen([
            str(runtime / 'bin/python'), '-I', '-m', 'alchemy_stub',
            '--server', f'http://127.0.0.1:{port}', '--token', token,
            '--default-cwd', str(job), '--default-output-dir', str(stage / 'runs'),
            '--max-concurrent', '1', '--no-warm-workers', '--idle-timeout', '240',
            '--tags', stage.name + ',t4-e2e,' + job_id],
            cwd=job, stdout=(job / 'daemon.log').open('w'), stderr=subprocess.STDOUT,
            start_new_session=True)
        processes.append(daemon)
        (job / 'ready.json').write_text(json.dumps({'job_id': job_id, 'daemon_pid': daemon.pid,
                                                   'runtime': str(runtime)}))
        deadline = time.monotonic() + 400
        while not (stage / 'STOP').exists():
            if daemon.poll() is not None:
                raise RuntimeError(f'daemon exited status {daemon.returncode}')
            if time.monotonic() >= deadline:
                raise TimeoutError('bounded test worker deadline expired')
            time.sleep(1)
        (job / 'completed.json').write_text(json.dumps({'test_controller_stop': True}))
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=5)
        (job / 'cleanup.json').write_text(json.dumps({'owned_processes_stopped': all(p.poll() is not None for p in processes)}))


if __name__ == '__main__':
    main()
