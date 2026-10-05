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
