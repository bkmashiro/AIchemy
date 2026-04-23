"""Entry point: python -m alchemy_stub"""
import asyncio
import signal
import sys
import time

from .config import Config
from .daemon import StubDaemon


class _GracefulRestart(Exception):
    """Raised by SIGUSR1 handler to trigger graceful restart."""


def main():
    config = Config()

    def _sigusr1_handler(signum, frame):
        print("[daemon] SIGUSR1 received, initiating graceful restart")
        raise _GracefulRestart()

    signal.signal(signal.SIGUSR1, _sigusr1_handler)

    while True:
        daemon = StubDaemon(config)
        try:
            asyncio.run(daemon.run())
        except KeyboardInterrupt:
            print("[daemon] Keyboard interrupt, exiting")
            sys.exit(0)
        except _GracefulRestart:
            print("[daemon] Graceful restart — re-creating daemon, tasks will be re-attached")
            time.sleep(1)
            continue
        except SystemExit:
            raise
        except Exception as e:
            print(f"[daemon] Unhandled exception: {e}, restarting in 5s")
            time.sleep(5)


if __name__ == "__main__":
    main()
