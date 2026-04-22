"""Entry point: python -m alchemy_stub"""
import asyncio
import sys
import time

from .config import Config
from .daemon import StubDaemon


def main():
    config = Config()
    daemon = StubDaemon(config)

    while True:
        try:
            asyncio.run(daemon.run())
        except KeyboardInterrupt:
            print("[daemon] Keyboard interrupt, exiting")
            sys.exit(0)
        except SystemExit:
            raise
        except Exception as e:
            print(f"[daemon] Unhandled exception: {e}, restarting in 5s")
            time.sleep(5)


if __name__ == "__main__":
    main()
