"""Real T4 Slurm allocation E2E; parent-owned SSH only, bounded resources."""
from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen

from alchemy_sdk import Experiment

REPO = Path(__file__).resolve().parents[2]
SSH = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
       '-o', 'ConnectTimeout=12', 'gpucluster2']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--sdk-wheel', type=Path, required=True)
    parser.add_argument('--stub-wheel', type=Path, required=True)
    args = parser.parse_args()
    for wheel in [args.sdk_wheel, args.stub_wheel]:
        if not wheel.is_file():
            parser.error(f'wheel does not exist: {wheel}')
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(mode=0o700)
    name = evidence.name
    stage = '/vol/bitbucket/ys25/alchemy-slurm-e2e/' + name
    runtime = '/vol/bitbucket/ys25/alchemy-envs/t4/cpython-3.12-' + name
    token = secrets.token_urlsafe(32)
    (evidence / 'token').write_text(token)
    os.chmod(evidence / 'token', 0o600)
    (evidence / 'deploy.yaml').write_text('tunnel:\n  enabled: false\nstubs: []\n')
    (evidence / 'login-known-hosts').write_text('cloud-vm-40-244.doc.ic.ac.uk ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILxt10DKTpo2k5sfuGvtE8GsFVMzg1h3v9tc3uqwkHBL\n')
    summary = {'status': 'running', 'stage': stage, 'runtime': runtime,
               'jobs': [], 'checks': [], 'tasks': {}}
    processes, files = [], []
    os.environ['ALCHEMY_TOKEN'] = token
    base = 'http://127.0.0.1:34227'
    start = time.monotonic()

    def save():
        (evidence / 'summary.json').write_text(json.dumps(summary, indent=2))

    def remote(code):
        result = subprocess.run([*SSH, 'python3 -'], input=code, text=True, capture_output=True, timeout=40)
        if result.returncode:
            raise RuntimeError('login SSH failed: ' + result.stderr[-1500:])
        return result.stdout

    def api(path, method='GET', body=None):
        req = Request(base + '/api' + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
                      method=method)
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    def check(label, condition, detail=None):
        summary['checks'].append({'check': label, 'passed': bool(condition), 'detail': detail})
        save()
        if not condition:
            raise AssertionError(label + ': ' + str(detail))
        print('PASS', label, flush=True)

    def wait(fn, timeout):
        deadline = min(start + 480, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = fn()
            if value:
                return value
            time.sleep(1)
        raise TimeoutError('bounded Slurm condition timeout')

    def submit(case, stub, memory, gpu=256):
        exp = Experiment(name + '-' + case, server=base)
        exp.base_config({'probe_parameter': 17})
        exp.task('train', script=runtime + '/bin/python',
                 argv=[stage + '/probe.py', '--stage', stage, '--case', case, '--steps', '4'],
                 cwd=stage, target_stub_id=stub,
                 requirements={'cpu_mem_mb': memory, 'gpu_mem_mb': gpu},
                 env={'PROBE_EXPLICIT_ENV': case})
        result = exp.submit(idempotency_key=name + '-' + case)
        tid = result.task_refs['train']
        summary['tasks'][tid] = {'case': case}
        save();print('SUBMITTED', case, tid, flush=True)
        return tid

    def task_wait(tid):
        def done():
            task = api('/tasks/' + tid)
            return task if task['status'] in ['completed', 'failed', 'cancelled'] else None
        task = wait(done, 60)
        summary['tasks'][tid].update(task)
        (evidence / (tid + '.json')).write_text(json.dumps(task, indent=2))
        save();return task

    try:
        import socket
        with socket.socket() as s:
            s.bind(('127.0.0.1', 34227))
        log = (evidence / 'server.log').open('w');files.append(log)
        env = {**os.environ, 'PORT': '34227', 'BIND_HOST': '127.0.0.1',
               'STATE_DIR': str(evidence), 'STATE_FILE': str(evidence / 'state.json'),
               'DB_FILE': str(evidence / 'state.db'), 'DEPLOY_CONFIG': str(evidence / 'deploy.yaml')}
        server = subprocess.Popen(['node', 'dist/index.js'], cwd=REPO / 'server', env=env,
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(server)
        def health():
            try:
                return api('/health')['status'] == 'ok'
            except OSError:
                return False
        wait(health, 15)
        log = (evidence / 'login-tunnel.log').open('w');files.append(log)
        tunnel = subprocess.Popen([*SSH[:-1], '-N', '-o', 'ExitOnForwardFailure=yes',
                                   '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                                   '-R', '127.0.0.1:34228:127.0.0.1:34227', SSH[-1]],
                                  stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(tunnel)
        time.sleep(2)
        wait(lambda: remote('from urllib.request import urlopen\nprint(urlopen("http://127.0.0.1:34228/api/health",timeout=2).status)\n').strip() == '200', 30)
        remote(f'from pathlib import Path\np=Path({stage!r});p.mkdir(parents=True,mode=0o700)\n(p/"runs").mkdir();(p/"entries").mkdir();(p/"input.txt").write_text("shared-read-only-probe-input\\n")\n')
        sdk_wheel, stub_wheel = args.sdk_wheel.resolve(), args.stub_wheel.resolve()
        for memory, prepare in [('1G', True), ('2G', False)]:
            batch = evidence / ('worker-' + memory + '.sbatch')
            batch.write_text(f'''#!/bin/bash
#SBATCH --partition=t4
#SBATCH --gres=gpu:tesla_t4:1
#SBATCH --cpus-per-task=1
#SBATCH --mem={memory}
#SBATCH --time=00:10:00
#SBATCH --job-name=alchemy-t4-{memory}
#SBATCH --output={stage}/slurm-%j.log
#SBATCH --chdir={stage}
set -euo pipefail
umask 077
/usr/bin/python3.12 -I {stage}/worker.py --stage {stage} --runtime {runtime} {'--prepare' if prepare else ''}
''')
        payload = [sdk_wheel, stub_wheel, REPO / 'tests/e2e/slurm_runtime_probe.py',
                   REPO / 'tests/e2e/slurm_test_worker.py', REPO / 'tests/e2e/icl_training_probe.py',
                   evidence / 'token', evidence / 'login-known-hosts',
                   evidence / 'worker-1G.sbatch', evidence / 'worker-2G.sbatch']
        result = subprocess.run(['scp', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                 *map(str, payload), 'gpucluster2:' + stage + '/'],
                                capture_output=True, text=True, timeout=50)
        if result.returncode:
            raise RuntimeError('Slurm stage SCP failed')
        remote(f'''from pathlib import Path
p=Path({stage!r});(p/'slurm_test_worker.py').rename(p/'worker.py');(p/'icl_training_probe.py').rename(p/'probe.py')
(p/'token').chmod(0o600)
''')
        for memory in ['1G', '2G']:
            output = remote(f'''import subprocess
p=subprocess.run(['sbatch','--parsable','--export=NIL',{(stage+'/worker-'+memory+'.sbatch')!r}],capture_output=True,text=True)
if p.returncode: raise RuntimeError(p.stderr)
print(p.stdout.strip())
''')
            jid = output.strip().split(';')[0]
            assert jid.isdigit(), output
            summary['jobs'].append(jid);save();print('SLURM_JOB', memory, jid, flush=True)
        def registered():
            stubs = api('/stubs')
            if not isinstance(stubs, list):
                stubs = stubs.get('stubs', [])
            found = {str(s.get('slurm_job_id')): s for s in stubs
                     if s.get('status') == 'online' and name in s.get('tags', [])}
            return found if all(j in found for j in summary['jobs']) else None
        stubs = wait(registered, 240)
        summary['stubs'] = stubs;save()
        probes = json.loads(remote(f'''from pathlib import Path
import json
p=Path({stage!r});print(json.dumps({{j:json.loads((p/('job-'+j)/'runtime-probe.json').read_text()) for j in {summary['jobs']!r}}}))
'''))
        summary['runtime_probes'] = probes;save()
        check('two_allocation_ids', len({s['id'] for s in stubs.values()}) == 2)
        check('same_physical_t4_node', len({p['hostname'] for p in probes.values()}) == 1)
        check('distinct_memory_limits', sorted(p['effective_memory_max_bytes'] for p in probes.values()) == [1073741824, 2147483648])
        check('one_t4_per_allocation', all(s['gpu']['count'] == 1 and 'T4' in s['gpu']['name'] for s in stubs.values()), {j:s['gpu'] for j,s in stubs.items()})
        check('distinct_visible_gpu_uuids', len({p['cuda_visible_devices'][0]['uuid'] for p in probes.values()}) == 2)
        check('reported_allocation_memory_matches_cgroup',
              all(int(stubs[j]['slurm_constraints']['mem_mb']) * 1024 * 1024
                  == probes[j]['effective_memory_max_bytes'] for j in summary['jobs']))
        check('gpu_allocation_scope_known', all(s['gpu'].get('allocation_known') for s in stubs.values()), {j:s['gpu'] for j,s in stubs.items()})
        a, b = summary['jobs']
        blocked = submit('over-small-allocation', stubs[a]['id'], 1536)
        time.sleep(2)
        task = api('/tasks/' + blocked)
        check('small_allocation_refuses_oversized_reservation', task['status'] == 'pending')
        diagnosis = api('/tasks/' + blocked + '/assignment-diagnosis')
        summary['oversize_diagnosis'] = diagnosis
        target = next(s for s in diagnosis['stubs'] if s['stub_id'] == stubs[a]['id'])
        check('oversized_request_has_cpu_memory_reason', 'cpu_memory_insufficient' in target['reasons'], target)
        api('/tasks/' + blocked, 'PATCH', {'status': 'cancelled'})
        summary['tasks'][blocked].update(api('/tasks/' + blocked))
        check('blocked_probe_cancelled', summary['tasks'][blocked]['status'] == 'cancelled')
        task_a = submit('allocation-a', stubs[a]['id'], 128)
        task_b = submit('allocation-b', stubs[b]['id'], 1536)
        result_a, result_b = task_wait(task_a), task_wait(task_b)
        check('both_gpu_scoped_tasks_complete', result_a['status'] == result_b['status'] == 'completed')
        check('shared_output_names_isolated', result_a['run_dir'] != result_b['run_dir'])
        result = json.loads(remote(f'''from pathlib import Path
import json
print(json.dumps([json.loads((Path(x)/'result.json').read_text()) for x in {[result_a['run_dir'],result_b['run_dir']]!r}]))
'''))
        check('real_sdk_installed_python312', all(x['prefix'] == runtime and x['sdk_origin'].startswith(runtime) for x in result))
        summary['status'] = 'passed'
    except BaseException as error:
        summary['status'] = 'failed';summary['error'] = str(error)
        print('SLURM_E2E_FAILED', type(error).__name__, str(error), flush=True)
        raise
    finally:
        try:
            text = remote(f'''from pathlib import Path
import json,subprocess,time,re
p=Path({stage!r});jobs={summary['jobs']!r}
if p.exists(): (p/'STOP').touch()
deadline=time.monotonic()+30
while jobs and time.monotonic()<deadline:
 if all((p/('job-'+j)/'cleanup.json').exists() for j in jobs): break
 time.sleep(.5)
time.sleep(1)
output={{'logs':{{}},'cleanup':{{}},'scheduler':{{}}}}
for j in jobs:
 f=p/('slurm-'+j+'.log');output['logs'][j]=f.read_text()[-30000:] if f.exists() else 'missing log'
 f=p/('job-'+j)/'cleanup.json';output['cleanup'][j]=json.loads(f.read_text()) if f.exists() else None
 r=subprocess.run(['scontrol','show','job',j],capture_output=True,text=True)
 output['scheduler'][j]=r.stdout or r.stderr
 state=re.search(r'JobState=(\\w+)',r.stdout)
 if state and state.group(1) in ['RUNNING','PENDING','COMPLETING','SUSPENDED']:
  subprocess.run(['scancel',j],capture_output=True)
  output['scheduler'][j]+='\\nController cancelled this still-active test job after bounded cleanup.'
print(json.dumps(output))
''')
            receipts = json.loads(text)
            (evidence / 'slurm-logs.json').write_text(json.dumps(receipts['logs'], indent=2))
            summary['cleanup'] = receipts['cleanup']
            summary['scheduler_receipts'] = receipts['scheduler']
            if summary['status'] == 'passed' and (
                    not all(v and v.get('owned_processes_stopped') for v in receipts['cleanup'].values())
                    or not all('JobState=COMPLETED' in v for v in receipts['scheduler'].values())):
                summary['status'] = 'cleanup_failed'
        except Exception as error:
            summary['cleanup_error'] = str(error)
            if summary['status'] == 'passed':
                summary['status'] = 'cleanup_failed'
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try: process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL);process.wait(timeout=5)
        for handle in files:handle.close()
        summary['local_processes_stopped'] = all(p.poll() is not None for p in processes)
        summary['duration_s'] = round(time.monotonic() - start, 2);save()
        print('EVIDENCE', evidence / 'summary.json', flush=True)
        if summary['status'] == 'cleanup_failed':
            raise RuntimeError('assertions passed but cleanup was not verified')


if __name__ == '__main__':
    main()
