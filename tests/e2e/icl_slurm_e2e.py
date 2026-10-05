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
    parser.add_argument('--controls', action='store_true', help='also validate checkpoint/stop and a real SSH link outage')
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

    def remote(code, timeout=40):
        result = subprocess.run([*SSH, 'python3 -'], input=code, text=True, capture_output=True, timeout=timeout)
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
#SBATCH --time=00:20:00
#SBATCH --job-name=alchemy-t4-{memory}
#SBATCH --output={stage}/slurm-%j.log
#SBATCH --chdir={stage}
set -euo pipefail
umask 077
/usr/bin/python3.12 -I {stage}/worker.py --stage {stage} --runtime {runtime} {'--prepare' if prepare else ''} &
worker_pid=$!
trap 'kill -USR1 "$worker_pid" 2>/dev/null || true' USR1
worker_status=0
while kill -0 "$worker_pid" 2>/dev/null; do
  if wait "$worker_pid"; then worker_status=0; else worker_status=$?; fi
done
exit "$worker_status"
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
        if args.controls:
            def read_trace(case):
                return json.loads(remote(f'from pathlib import Path\nimport sys\nsys.stdout.write((Path({stage!r})/"entries"/{(case+".json")!r}).read_text())\n'))

            case = 'cooperative-control'
            remote(f'from pathlib import Path\n(Path({stage!r})/{("fail-once-"+case)!r}).touch()\n')
            exp = Experiment(name + '-controls', server=base)
            exp.base_config({'probe_parameter': 17})
            train = exp.task('train', script=runtime + '/bin/python',
                             argv=[stage + '/probe.py', '--stage', stage, '--case', case,
                                   '--mode', 'control', '--steps', '2000'], cwd=stage,
                             target_stub_id=stubs[a]['id'], requirements={'cpu_mem_mb': 128, 'gpu_mem_mb': 256})
            exp.task('must-not-run', script='/bin/true', depends_on=[train], cwd=stage,
                     target_stub_id=stubs[a]['id'], requirements={'cpu_mem_mb': 64})
            submitted = exp.submit(idempotency_key=name + '-controls')
            tid, downstream = submitted.task_refs['train'], submitted.task_refs['must-not-run']
            summary['tasks'][tid] = {'case': case}
            summary['tasks'][downstream] = {'case': 'blocked-descendant'}
            wait(lambda: api('/tasks/' + tid).get('progress'), 30)

            def checkpoint_request():
                api('/tasks/' + tid, 'PATCH', {'should_checkpoint': False})
                patched = api('/tasks/' + tid, 'PATCH', {'should_checkpoint': True})
                return patched['control_requests'][-1]['request_id']

            def control_state(request_id):
                task = api('/tasks/' + tid)
                return next(c for c in task['control_requests'] if c['request_id'] == request_id)

            failed_request = checkpoint_request()
            wait(lambda: control_state(failed_request)['status'] == 'received', 20)
            trace = read_trace(case)
            check('failed_save_not_falsely_completed', control_state(failed_request)['status'] != 'completed'
                  and any(e['request_id'] == failed_request for e in trace['errors']))
            first_request = checkpoint_request()
            wait(lambda: control_state(first_request)['status'] == 'completed', 25)
            saved = control_state(first_request)
            body = json.loads(remote(f'from pathlib import Path\nprint(Path({saved["path"]!r}).read_text())\n'))
            check('checkpoint_completion_corresponds_to_real_file', body['request_id'] == first_request and body['task_id'] == tid)
            duplicate = api('/tasks/' + tid, 'PATCH', {'should_checkpoint': True})
            check('repeat_checkpoint_patch_reuses_identity', len(duplicate['control_requests']) == 2)
            wait(lambda: api('/tasks/' + tid).get('checkpoint_path', '').endswith('/periodic.json'), 20)
            check('periodic_save_does_not_overwrite_control_path', control_state(first_request)['path'] == saved['path'])

            before = read_trace(case)
            previous_pid = api('/tasks/' + tid)['pid']
            tunnel.terminate();tunnel.wait(timeout=10)
            def disconnected():
                task = api('/tasks/' + tid)
                return task if task.get('disconnected_at') else None
            offline = wait(disconnected, 25)
            check('link_loss_does_not_fail_training', offline['status'] == 'running' and offline['pid'] == previous_pid)
            offline_request = checkpoint_request()
            check('offline_control_stays_pending', control_state(offline_request)['status'] == 'pending')
            after = read_trace(case)
            check('training_advances_while_server_unreachable', after['step'] > before['step'])
            reconnect_log = (evidence / 'reconnect-tunnel.log').open('w');files.append(reconnect_log)
            tunnel = subprocess.Popen([*SSH[:-1], '-N', '-o', 'ExitOnForwardFailure=yes',
                                       '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                                       '-R', '127.0.0.1:34228:127.0.0.1:34227', SSH[-1]],
                                      stdout=reconnect_log, stderr=subprocess.STDOUT, start_new_session=True)
            processes.append(tunnel)
            wait(lambda: control_state(offline_request)['status'] == 'completed', 65)
            recovered = api('/tasks/' + tid)
            check('same_task_and_pid_survive_reconnect', recovered['pid'] == previous_pid and not recovered.get('disconnected_at'))
            trace = read_trace(case)
            requested = [c for c in trace['checkpoints'] if c['kind'] == 'requested']
            check('replayed_requests_saved_exactly_once', [c['request_id'] for c in requested] == [first_request, offline_request], requested)
            stopped = api('/tasks/' + tid, 'PATCH', {'should_stop': True})
            stop_id = stopped['control_requests'][-1]['request_id']
            final = task_wait(tid)
            check('cooperative_zero_exit_is_cancelled', final['status'] == 'cancelled' and final.get('exit_code') == 0
                  and final.get('death_cause') == 'cooperative_stop')
            check('stop_received_by_sdk', any(c['request_id'] == stop_id and c['status'] == 'received' for c in final['control_requests']))
            descendant = api('/tasks/' + downstream)
            summary['tasks'][downstream].update(descendant)
            check('stopped_training_does_not_promote_success_dag', descendant['status'] == 'cancelled' and not descendant.get('pid'))
            terminal_experiment = wait(lambda: (
                lambda data: data if data['status'] != 'running' else None
            )(api('/experiments/' + submitted.experiment_id)), 10)
            check('stopped_experiment_is_terminal_non_success', terminal_experiment['status'] in ['failed', 'partial', 'cancelled'], terminal_experiment['status'])
            final_report = json.loads(remote(f'from pathlib import Path\nprint((Path({final["run_dir"]!r})/"control-result.json").read_text())\n'))
            check('stop_saves_checkpoint_and_result_before_exit', final_report['stopped']
                  and final_report['checkpoints'][-1]['kind'] == 'stop' and len(final_report['seen']) < 2000)
            summary['control_result'] = final_report
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
if jobs:
 subprocess.run(['scancel','--signal=USR1','--batch',*jobs],capture_output=True)

def cleanup_receipt(j):
 # The Slurm stdout file existed from startup; use its explicit receipt to
 # avoid negative-directory caching of newly created shared-mount files.
 log=p/('slurm-'+j+'.log')
 if log.exists():
  for line in reversed(log.read_text().splitlines()):
   try: item=json.loads(line)
   except ValueError: continue
   if isinstance(item,dict) and item.get('job_id')==j and 'test_cleanup_receipt' in item:
    return item['test_cleanup_receipt']
 f=p/('job-'+j)/'cleanup.json'
 return json.loads(f.read_text()) if f.exists() else None

deadline=time.monotonic()+30
while jobs and time.monotonic()<deadline:
 if all(cleanup_receipt(j) for j in jobs): break
 time.sleep(.5)
time.sleep(3)
output={{'logs':{{}},'cleanup':{{}},'scheduler':{{}}}}
for j in jobs:
 f=p/('slurm-'+j+'.log');output['logs'][j]=f.read_text()[-30000:] if f.exists() else 'missing log'
 output['cleanup'][j]=cleanup_receipt(j)
 r=subprocess.run(['scontrol','show','job',j],capture_output=True,text=True)
 output['scheduler'][j]=r.stdout or r.stderr
 state=re.search(r'JobState=(\\w+)',r.stdout)
 if state and state.group(1)=='COMPLETING' and output['cleanup'][j]:
  # Batch exit and scheduler epilog completion are separate acknowledgements.
  # Do not cancel a successfully exiting job merely because epilog is in flight.
  time.sleep(10)
  r=subprocess.run(['scontrol','show','job',j],capture_output=True,text=True)
  output['scheduler'][j]=r.stdout or r.stderr
  state=re.search(r'JobState=(\\w+)',r.stdout)
 if state and state.group(1) in ['RUNNING','PENDING','SUSPENDED']:
  subprocess.run(['scancel',j],capture_output=True)
  output['scheduler'][j]+='\\nController cancelled this still-active test job after bounded cleanup.'
print(json.dumps(output))
''', timeout=80)
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
