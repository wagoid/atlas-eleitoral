import argparse
import json
import sys
from pathlib import Path

from pipeline.build import build
from pipeline.sources import fetch_all


def main() -> int:
    parser = argparse.ArgumentParser(prog="pipeline", description="Atlas eleitoral 2026: baixa, processa e valida")
    parser.add_argument("command", choices=["fetch", "build", "all"])
    parser.add_argument("--cache", type=Path, default=Path(".cache"))
    parser.add_argument("--out", type=Path, default=Path("site/data"))
    parser.add_argument("--refresh", action="store_true", help="baixa de novo mesmo com arquivo em cache")
    args = parser.parse_args()

    if args.command in ("fetch", "all"):
        fetch_all(args.cache, refresh=args.refresh)
    if args.command in ("build", "all"):
        checks = build(args.cache, args.out)
        summary = checks.summary()
        print(json.dumps(summary, ensure_ascii=False, indent=2))
        for failure in checks.failures()[:30]:
            print("DIVERGÊNCIA", json.dumps(failure, ensure_ascii=False))
        if summary["failed"] or summary["invariant_violations"]:
            print("validação falhou: veja site/data/reconciliation.json", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
