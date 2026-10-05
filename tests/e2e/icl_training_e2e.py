"""Bounded real ICL E2E. No production server, no broad process cleanup.

Run from the repository using a Python that can import the local SDK:
  PYTHONPATH=sdk python3 tests/e2e/icl_training_e2e.py --evidence <private-dir>
Requires existing SSH access to gpu32/33 via gpucluster2 and installed wheels.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import json
import os
import secrets
import signal
import socket
import subprocess
import time
from typing import Any
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from alchemy_sdk import Experiment

REPO = Path(__file__).resolve().parents[2]
RUNTIME = '/vol/bitbucket/ys25/alchemy-envs/gpu32/cpython-3.14-sdk-6984e28'
SSH_BASE = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
            '-o', 'ConnectTimeout=12', '-J', 'gpucluster2']
TERMINAL = {'completed', 'failed', 'cancelled', 'blocked'}


def ssh(host, code, timeout=45):
    result = subprocess.run([*SSH_BASE, f'ys25@{host}', 'python3 -'],
                            input=code, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'SSH {host} failed ({result.returncode}): {result.stderr[-1800:]}')
    return result.stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--port', type=int, default=34127)
    args = parser.parse_args()
    evidence = Path(args.evidence).resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    os.chmod(evidence, 0o700)
    generation = evidence.name
    control_path = str(evidence.parent / ('ic-' + secrets.token_hex(4) + '-%h'))
    SSH_BASE.extend(['-o', 'ControlMaster=auto', '-o', 'ControlPersist=60',
                     '-o', 'ControlPath=' + control_path])
    stage = f'/vol/bitbucket/ys25/alchemy-e2e/{generation}'
    token = secrets.token_urlsafe(32)
    credential = evidence / 'token'
    credential.write_text(token)
    os.chmod(credential, 0o600)
    deploy = evidence / 'deploy.yaml'
    deploy.write_text('tunnel:\n  enabled: false\nstubs: []\n')
    os.environ['ALCHEMY_TOKEN'] = token
    base_url = f'http://127.0.0.1:{args.port}'
    processes = []
    logfiles = []
    daemon_pids = {}
    tasks = {}
    assertions = []
    started = time.monotonic()
    summary = {'generation': generation, 'remote_stage': stage, 'cases': [],
               'assertions': assertions, 'cleanup': {}, 'status': 'running'}

    def save():
        (evidence / 'summary.json').write_text(json.dumps(summary, indent=2))

    def api(path, method='GET', body=None, url=None):
        headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}
        req = Request((url or base_url) + '/api' + path,
                      data=json.dumps(body).encode() if body is not None else None,
                      headers=headers, method=method)
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    def check(label, condition, detail=None):
        assertions.append({'check': label, 'passed': bool(condition), 'detail': detail})
        save()
        if not condition:
            raise AssertionError(f'{label}: {detail}')
        print('PASS', label, flush=True)

    def poll(fn, timeout=90):
        deadline = min(started + 580, time.monotonic() + timeout)
        while time.monotonic() < deadline:
            value = fn()
            if value:
                return value
            time.sleep(0.8)
        raise TimeoutError('bounded E2E condition did not become true')

    def task_wait(task_id, url=None):
        def ready():
            data = api('/tasks/' + task_id, url=url)
            return data if data.get('status') in TERMINAL else None
        data = poll(ready)
        tasks[task_id] = data
        (evidence / (task_id + '.json')).write_text(json.dumps(data, indent=2))
        return data

    def read_remote(path, json_file=True) -> Any:
        code = f'from pathlib import Path\nimport sys\nsys.stdout.write(Path({path!r}).read_text())\n'
        text = ssh('gpu32', code)
        return json.loads(text) if json_file else text

    def submit(case, host, mode='normal', steps=4, resume=None):
        exp = Experiment(f'{generation}-{case}', server=base_url)
        exp.base_config({'probe_parameter': 17})
        argv = [stage + '/probe.py', '--stage', stage, '--case', case,
                '--mode', mode, '--steps', str(steps)]
        if resume:
            argv.extend(['--resume', resume])
        exp.task('train', script=RUNTIME + '/bin/python', argv=argv,
                 cwd=stage, target_stub_id=stubs[host],
                 requirements={'cpu_mem_mb': 128},
                 env={'PROBE_EXPLICIT_ENV': case})
        result = exp.submit(idempotency_key=generation + '-' + case)
        tid = result.task_refs['train']
        tasks[tid] = {'id': tid}
        summary['cases'].append({'case': case, 'task_id': tid,
                                 'experiment_id': result.experiment_id, 'host': host})
        save()
        print('SUBMITTED', case, tid, flush=True)
        return tid

    try:
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', args.port))
        server_log = (evidence / 'server.log').open('w')
        logfiles.append(server_log)
        env = {**os.environ, 'PORT': str(args.port), 'BIND_HOST': '127.0.0.1',
               'DEPLOY_CONFIG': str(deploy), 'STATE_DIR': str(evidence),
               'STATE_FILE': str(evidence / 'state.json'), 'DB_FILE': str(evidence / 'state.db')}
        server = subprocess.Popen(['node', 'dist/index.js'], cwd=REPO / 'server', env=env,
                                  stdout=server_log, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(server)
        poll(lambda: server.poll() is None and healthy(base_url), timeout=20)
        check('isolated_server_health', api('/health')['status'] == 'ok')
        for endpoint, payload in [
            ('/tasks', {'script': RUNTIME + '/bin/python', 'requirements': {'gpu_mem_mb': 0}}),
            ('/experiments', {'name': 'invalid-memory', 'task_specs': [
                {'ref': 'train', 'script': RUNTIME + '/bin/python', 'requirements': {'gpu_mem_mb': 0}}]}),
        ]:
            try:
                api(endpoint, 'POST', payload)
            except HTTPError as error:
                message = json.loads(error.read()).get('error', '')
                error.close()
                check('invalid_memory_rejected_at_' + endpoint.strip('/'),
                      error.code == 400 and 'positive finite number' in message, message)
            else:
                raise AssertionError('invalid memory request was admitted')
        check('invalid_admission_no_pending_task', api('/health')['tasks_pending'] == 0)
        for host, remote_port in [('gpu32', 34128), ('gpu33', 34129)]:
            handle = (evidence / (host + '-tunnel.log')).open('w')
            logfiles.append(handle)
            tunnel = subprocess.Popen([*SSH_BASE, '-N', '-o', 'ExitOnForwardFailure=yes',
                                       '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
                                       '-R', f'127.0.0.1:{remote_port}:127.0.0.1:{args.port}',
                                       f'ys25@{host}'], stdout=handle, stderr=subprocess.STDOUT,
                                      start_new_session=True)
            processes.append(tunnel)
            def forwarded():
                if tunnel.poll() is not None:
                    raise RuntimeError(f'{host} reverse forwarding exited')
                try:
                    output = ssh(host, f'from urllib.request import urlopen\nprint(urlopen("http://127.0.0.1:{remote_port}/api/health",timeout=2).status)\n', timeout=20)
                    return output.strip() == '200'
                except RuntimeError:
                    return False
            poll(forwarded, timeout=40)
            check(host + '_reverse_health', True)
        setup = f'''from pathlib import Path
p=Path({stage!r});p.mkdir(parents=True,exist_ok=False)
(p/'entries').mkdir();(p/'runs').mkdir();(p/'input.txt').write_text('shared-read-only-probe-input\\n')
'''
        ssh('gpu32', setup)
        result = subprocess.run(['scp', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                                 '-o', 'ProxyJump=gpucluster2', str(REPO / 'tests/e2e/icl_training_probe.py'),
                                 f'ys25@gpu32:{stage}/probe.py'], capture_output=True, text=True, timeout=45)
        if result.returncode:
            raise RuntimeError('probe SCP failed: ' + result.stderr[-1000:])
        for host, remote_port in [('gpu32', 34128), ('gpu33', 34129)]:
            code = f'''import subprocess,json,os
from pathlib import Path
stage=Path({stage!r});log=(stage/{(host+'.daemon.log')!r}).open('w')
command=[{(RUNTIME+'/bin/python')!r},'-I','-m','alchemy_stub','--server','http://127.0.0.1:{remote_port}','--token',{token!r},'--default-cwd',{stage!r},'--default-output-dir',str(stage/'runs'),'--max-concurrent','1','--no-warm-workers','--idle-timeout','300','--tags','{generation},{host}']
p=subprocess.Popen(command,cwd=stage,stdout=log,stderr=subprocess.STDOUT,start_new_session=True,env={{**os.environ,'PYTHONDONTWRITEBYTECODE':'1'}})
(stage/{(host+'.pid')!r}).write_text(str(p.pid)); print(json.dumps({{'pid':p.pid}}))
'''
            daemon_pids[host] = json.loads(ssh(host, code))['pid']
        def connected():
            response = api('/stubs')
            items = response if isinstance(response, list) else response.get('stubs', [])
            found = {s['hostname']: s['id'] for s in items
                     if s.get('status') == 'online' and generation in s.get('tags', [])}
            return found if all(h in found for h in ['gpu32', 'gpu33']) else None
        stubs = poll(connected, timeout=60)
        summary['stubs'] = stubs
        summary['daemon_pids'] = daemon_pids
        save()
        check('two_real_daemons_connected', len(stubs) == 2)
        tid = submit('single', 'gpu32')
        state = task_wait(tid)
        check('single_task_completed', state['status'] == 'completed', state.get('error'))
        report = read_remote(state['run_dir'] + '/result.json')
        check('single_socket_and_installed_sdk', report['transport'] == 'UnixSocketTransport' and report['sdk_origin'].startswith(RUNTIME))
        check('single_correct_task_config_and_env', report['task_id'] == tid
              and report['resolved_config'].get('probe_parameter') == 17
              and report['explicit_env'] == 'single', report['resolved_config'])
        metric = api('/tasks/' + tid + '/metrics')
        (evidence / 'single-metrics.json').write_text(json.dumps(metric, indent=2))
        check('single_metrics_reached_server', bool(metric.get('metrics_buffer') or metric.get('points')), list(metric))
        left = submit('parallel32', 'gpu32')
        right = submit('parallel33', 'gpu33')
        a, b = task_wait(left), task_wait(right)
        check('both_parallel_completed', a['status'] == b['status'] == 'completed')
        reports = [read_remote(x['run_dir'] + '/result.json') for x in [a, b]]
        timestamps = lambda task, field: datetime.fromisoformat(task[field].replace('Z', '+00:00'))
        check('parallel_tasks_actually_overlap',
              max(timestamps(x, 'started_at') for x in [a, b])
              < min(timestamps(x, 'finished_at') for x in [a, b]))
        check('parallel_output_isolation', a['run_dir'] != b['run_dir'] and {r['task_id'] for r in reports} == {left, right})
        check('shared_env_two_hosts', {r['hostname'] for r in reports} == {'gpu32', 'gpu33'} and all(r['sdk_origin'].startswith(RUNTIME) for r in reports))
        check('shared_input_unchanged', read_remote(stage + '/input.txt', False) == 'shared-read-only-probe-input\n')
        # A second real server avoids the first server's admission write lock,
        # exercising cross-server filesystem ownership rather than bypassing it.
        secondary_url = f'http://127.0.0.1:{args.port + 3}'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', args.port + 3))
        secondary_dir = evidence / 'secondary'
        secondary_dir.mkdir()
        secondary_log = (secondary_dir / 'server.log').open('w')
        logfiles.append(secondary_log)
        secondary_env = {**env, 'PORT': str(args.port + 3),
                         'STATE_DIR': str(secondary_dir),
                         'STATE_FILE': str(secondary_dir / 'state.json'),
                         'DB_FILE': str(secondary_dir / 'state.db')}
        secondary_server = subprocess.Popen(['node', 'dist/index.js'], cwd=REPO / 'server',
                                            env=secondary_env, stdout=secondary_log,
                                            stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(secondary_server)
        poll(lambda: secondary_server.poll() is None and healthy(secondary_url), timeout=20)
        secondary_tunnel_log = (evidence / 'secondary-tunnel.log').open('w')
        logfiles.append(secondary_tunnel_log)
        secondary_tunnel = subprocess.Popen([*SSH_BASE, '-N', '-o', 'ExitOnForwardFailure=yes',
                                            '-R', f'127.0.0.1:34131:127.0.0.1:{args.port + 3}',
                                            'ys25@gpu33'], stdout=secondary_tunnel_log,
                                           stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(secondary_tunnel)
        poll(lambda: ssh('gpu33', 'from urllib.request import urlopen\nprint(urlopen("http://127.0.0.1:34131/api/health",timeout=2).status)\n').strip() == '200', timeout=20)
        secondary_code = f'''from pathlib import Path
import subprocess,os,json
stage=Path({stage!r});cwd=stage/'independent';cwd.mkdir()
log=(stage/'gpu33-independent.daemon.log').open('w')
command=[{(RUNTIME+'/bin/python')!r},'-I','-m','alchemy_stub','--server','http://127.0.0.1:34131','--token',{token!r},'--default-cwd',str(cwd),'--default-output-dir',str(stage/'runs'),'--max-concurrent','1','--no-warm-workers','--idle-timeout','300','--tags','{generation},independent']
p=subprocess.Popen(command,cwd=cwd,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
print(json.dumps({{'pid':p.pid}}))
'''
        daemon_pids['gpu33-independent'] = json.loads(ssh('gpu33', secondary_code))['pid']
        def secondary_connected():
            response = api('/stubs', url=secondary_url)
            items = response if isinstance(response, list) else response.get('stubs', [])
            return next((s['id'] for s in items if s.get('status') == 'online'), None)
        secondary_stub = poll(secondary_connected, timeout=45)
        summary['secondary_stub'] = secondary_stub
        check('independent_server_and_daemon_connected', bool(secondary_stub))
        # Experiment task_specs currently do not expose run_dir. This deliberate
        # collision uses real task APIs; both workloads still use the SDK.
        shared = stage + '/forced-conflict'
        conflict_ids = []
        conflict_urls = []
        for host in ['gpu32', 'gpu33']:
            case = 'conflict-' + host
            payload = {'script': RUNTIME + '/bin/python',
                       'argv': [stage + '/probe.py', '--stage', stage, '--case', case, '--steps', '8'],
                       'cwd': stage, 'run_dir': shared, 'target_stub_id': stubs[host],
                       'requirements': {'cpu_mem_mb': 128},
                       'param_overrides': {'probe_parameter': 17}, 'env': {'PROBE_EXPLICIT_ENV': case}}
            url = base_url if host == 'gpu32' else secondary_url
            payload['target_stub_id'] = stubs['gpu32'] if host == 'gpu32' else secondary_stub
            task = api('/tasks', 'POST', payload, url=url)
            conflict_urls.append(url)
            conflict_ids.append(task['id']);tasks[task['id']] = task
        conflict_states = [task_wait(t, url=u) for t, u in zip(conflict_ids, conflict_urls)]
        check('conflict_only_one_completed', sorted(t['status'] for t in conflict_states) == ['completed', 'failed'], [t['status'] for t in conflict_states])
        loser = next(t for t in conflict_states if t['status'] == 'failed')
        check('conflict_failed_before_spawn', not loser.get('pid')
              and any('already claimed' in line for line in loser.get('log_buffer', [])))
        winner = read_remote(shared + '/result.json')
        check('conflict_winner_preserved', winner['task_id'] in conflict_ids)
        check('sdk_param_overrides_reached_training', winner['params'].get('probe_parameter') == 17)
        entry_count = json.loads(ssh('gpu32', f'from pathlib import Path\nimport json\nprint(json.dumps(sum((Path({stage!r})/"entries"/("conflict-"+h+".json")).exists() for h in ["gpu32","gpu33"])))\n'))
        check('conflict_loser_never_entered_training', entry_count == 1, entry_count)
        for mode in ['missing_read', 'bad_write', 'exception']:
            tid = submit(mode, 'gpu32', mode=mode)
            failed = task_wait(tid)
            check(mode + '_failed', failed['status'] == 'failed', failed.get('error'))
            exists = json.loads(ssh('gpu32', f'from pathlib import Path\nimport json\nprint(json.dumps(Path({(stage+"/entries/"+mode+".json")!r}).exists()))\n'))
            check(mode + '_entry_boundary', exists == (mode == 'exception'), exists)
        tid = submit('checkpoint-first', 'gpu32', mode='managed', steps=3)
        first = task_wait(tid)
        check('checkpoint_first_completed', first['status'] == 'completed', first.get('error'))
        checkpoint_path = first.get('exports', {}).get('last_checkpoint_path')
        check('checkpoint_reference_published', bool(checkpoint_path)
              and checkpoint_path.startswith(first['run_dir'] + '/'), checkpoint_path)
        tid2 = submit('checkpoint-resumed', 'gpu33', mode='managed', steps=6,
                      resume=checkpoint_path)
        resumed = task_wait(tid2)
        check('checkpoint_resumed_completed', resumed['status'] == 'completed', resumed.get('error'))
        resumed_report = read_remote(resumed['run_dir'] + '/results.json')
        check('checkpoint_next_step_no_repeat', resumed_report['seen'] == list(range(6)), resumed_report['seen'])
        check('checkpoint_new_output_directory', resumed['run_dir'] != first['run_dir'])
        summary['status'] = 'passed'
    except BaseException as error:
        summary['status'] = 'failed'
        summary['error'] = f'{type(error).__name__}: {error}'
        print('E2E_FAILED', summary['error'], flush=True)
        raise
    finally:
        summary['tasks'] = tasks
        # Stop only processes created by this generation. Never broad pkill.
        for host, pid in daemon_pids.items():
            try:
                code = f'''import os,signal,time,json
from pathlib import Path
owned_tasks=set({list(tasks)!r})
stopped_tasks=[]
for proc in Path('/proc').iterdir():
 if not proc.name.isdigit(): continue
 try:
  if proc.stat().st_uid != os.getuid(): continue
  env_items=(proc/'environ').read_bytes().split(b'\\x00')
  task=next((v.split(b'=',1)[1].decode() for v in env_items if v.startswith(b'ALCHEMY_TASK_ID=')),None)
  if task in owned_tasks:
   pg=os.getpgid(int(proc.name))
   if pg==int(proc.name):
    os.killpg(pg,signal.SIGTERM);stopped_tasks.append(task)
 except (OSError,PermissionError,ProcessLookupError): pass
pid={pid};p=Path('/proc')/str(pid)
if p.exists():
 cmd=(p/'cmdline').read_bytes()
 if {stage.encode()!r} not in cmd: raise RuntimeError('refuse to stop unrelated PID')
 os.killpg(pid,signal.SIGTERM)
 for _ in range(30):
  if not p.exists() or (p/'stat').read_text().split()[2]=='Z': break
  time.sleep(0.2)
 else: os.killpg(pid,signal.SIGKILL)
print(json.dumps({{'daemon_stopped':not p.exists() or (p/'stat').read_text().split()[2]=='Z'}}))
'''
                summary['cleanup'][host] = json.loads(ssh(host.split('-')[0], code))
            except Exception as error:
                summary['cleanup'][host] = {'error': str(error)}
        # Retrieve bounded private logs while the SSH masters are still alive.
        for host in daemon_pids:
            try:
                text = ssh(host.split('-')[0], f'from pathlib import Path\nimport sys\np=Path({stage!r})/{(host+".daemon.log")!r}\nsys.stdout.write(p.read_text()[-50000:])\n')
                (evidence / (host + '-daemon.log')).write_text(text)
            except Exception as error:
                summary['cleanup'][host]['log_error'] = str(error)
        for host in ['gpu32', 'gpu33']:
            subprocess.run([*SSH_BASE, '-O', 'exit', f'ys25@{host}'],
                           capture_output=True, timeout=10)
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL);process.wait(timeout=5)
        summary['cleanup']['local_processes_stopped'] = all(p.poll() is not None for p in processes)
        for handle in logfiles:
            handle.close()
        summary['duration_s'] = round(time.monotonic() - started, 2)
        save()
        print('EVIDENCE', evidence / 'summary.json', flush=True)
        if summary['status'] == 'passed' and (
                not summary['cleanup'].get('local_processes_stopped')
                or any(not summary['cleanup'].get(host, {}).get('daemon_stopped')
                       for host in daemon_pids)):
            summary['status'] = 'cleanup_failed'
            save()
            raise RuntimeError('E2E assertions passed but process cleanup is incomplete')


def healthy(base_url):
    try:
        with urlopen(base_url + '/api/health', timeout=2) as response:
            return response.status == 200
    except OSError:
        return False


if __name__ == '__main__':
    main()
