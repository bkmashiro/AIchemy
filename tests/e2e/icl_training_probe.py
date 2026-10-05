"""Small real SDK workload. Run through an Alchemy task, not directly by SSH."""
from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
from pathlib import Path

import alchemy_sdk
from alchemy_sdk import Alchemy, TrainingContext
from alchemy_sdk.managed import ManagedTraining


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--stage', required=True)
    parser.add_argument('--case', required=True)
    parser.add_argument('--mode', default='normal')
    parser.add_argument('--steps', type=int, default=4)
    parser.add_argument('--resume')
    args = parser.parse_args()
    stage = Path(args.stage)
    entry = stage / 'entries' / (args.case + '.json')
    al = Alchemy()
    provenance = {
        'hostname': socket.gethostname(), 'executable': sys.executable,
        'prefix': sys.prefix, 'sdk_origin': alchemy_sdk.__file__,
        'sdk_version': alchemy_sdk.__version__, 'cwd': str(Path.cwd()),
        'task_id': os.environ.get('ALCHEMY_TASK_ID'),
        'transport': type(al._transport).__name__, 'params': al.params(),
        'explicit_env': os.environ.get('PROBE_EXPLICIT_ENV'),
        'resolved_config': (json.loads(Path(os.environ['ALCHEMY_CONFIG']).read_text())
                            if os.environ.get('ALCHEMY_CONFIG') else None),
    }
    assert provenance['transport'] == 'UnixSocketTransport', provenance
    assert Path(alchemy_sdk.__file__).is_relative_to(Path(sys.prefix))
    assert alchemy_sdk.__version__ == '2.2.0'
    source = stage / ('missing-input' if args.mode == 'missing_read' else 'input.txt')
    writes = [str(stage / 'missing-parent' / 'output')] if args.mode == 'bad_write' else []

    if args.mode == 'control':
        @al.managed(total_steps=args.steps, reads=[str(stage / 'input.txt')], device='cpu')
        def controlled(ctx):
            checkpoints, errors = [], []
            periodic_written = False
            seen = []

            def save_checkpoint(kind, request_id=None):
                nonlocal checkpoints
                failure = stage / ('fail-once-' + args.case)
                if kind == 'requested' and failure.exists():
                    failure.unlink()
                    raise OSError('intentional checkpoint save failure')
                path = ctx.checkpoint_dir / ((request_id or kind) + '.json')
                temporary = path.with_suffix('.tmp')
                temporary.write_text(json.dumps({'task_id': provenance['task_id'],
                                                  'request_id': request_id, 'kind': kind, 'seen': seen}))
                temporary.replace(path)
                al.checkpoint(str(path))
                checkpoints.append({'kind': kind, 'request_id': request_id, 'path': str(path)})

            for step in ctx.steps():
                seen.append(step)
                if al.should_checkpoint():
                    request_id = al._transport.checkpoint_request_id()
                    try:
                        save_checkpoint('requested', request_id)
                    except OSError as error:
                        errors.append({'request_id': request_id, 'error': str(error)})
                if not periodic_written and any(c['kind'] == 'requested' for c in checkpoints):
                    save_checkpoint('periodic')
                    periodic_written = True
                entry.write_text(json.dumps({**provenance, 'run_dir': str(ctx.run_dir),
                                             'step': step, 'checkpoints': checkpoints, 'errors': errors}))
                ctx.log(loss=1.0 / (step + 1))
                time.sleep(0.2)
            stopped = al.should_stop()
            if stopped:
                save_checkpoint('stop')
            ctx.write_result({**provenance, 'stopped': stopped, 'seen': seen,
                              'checkpoints': checkpoints, 'errors': errors}, 'control-result.json')
            return {'stopped': int(stopped)}

        controlled()
        return

    if args.mode == 'managed':
        # The restored state tracks actual executed steps, independently of filenames.
        al._transport.close()

        class CountingTraining(ManagedTraining):
            def setup(self, config):
                self.seen = []

            def state(self):
                return {'seen': self.seen}

            def load_state(self, state):
                self.seen = list(state['seen'])

            def step_fn(self, batch):
                self.seen.append(self._current_step)
                entry.write_text(json.dumps({**provenance, 'seen': self.seen}))
                ctx = TrainingContext(self._alchemy, total_steps=args.steps)
                ctx.write_result({**provenance, 'seen': self.seen, 'case': args.case})
                time.sleep(0.4)
                return {'loss': 1.0 / (self._current_step + 1)}

        # ManagedTraining parses known CLI flags; the probe's --steps is distinct.
        ManagedTraining.run(CountingTraining, total_steps=args.steps,
                            checkpoint_every_steps=1, resume_from=args.resume)
        return

    @al.managed(total_steps=args.steps, reads=[str(source)], writes=writes, device='cpu')
    def train(ctx):
        entry.write_text(json.dumps({**provenance, 'run_dir': str(ctx.run_dir)}))
        if args.mode == 'exception':
            raise RuntimeError('intentional E2E training exception')
        assert source.read_text() == 'shared-read-only-probe-input\n'
        for step in ctx.steps():
            ctx.log(loss=1.0 / (step + 1), probe_metric=float(step))
            time.sleep(0.7)
        checkpoint = ctx.checkpoint_dir / 'checkpoint.json'
        checkpoint.write_text(json.dumps({'case': args.case, 'task_id': provenance['task_id']}))
        al.checkpoint(str(checkpoint))
        ctx.log_eval({'probe_eval': 17.0})
        result = {**provenance, 'case': args.case, 'run_dir': str(ctx.run_dir),
                  'checkpoint': str(checkpoint), 'input': str(source)}
        ctx.write_result(result, path='result.json')
        # Give the real socket consumer time to drain before process completion.
        time.sleep(0.8)
        return {'probe_complete': 1.0}

    train()


if __name__ == '__main__':
    main()
