#!/usr/bin/env python3
"""Compare the load test results with the Phase 8 targets (task.md P8.3-P8.8).

Reads the k6 summary files written by `run.sh` (results/<scenario>-<time>.json) and
prints a table: target, measured, status.

    python3 infra/loadtest/scripts/report_targets.py infra/loadtest/results

The script only reads files; it sends nothing to the server.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

TARGETS = {
    "P8.3": ("simple read p95", "< 150 ms"),
    "P8.4": ("stop event p95", "< 250 ms"),
    "P8.5": ("route open (200 stops), gzipped", "< 150 KB"),
    "P8.6": ("optimise 200 stops", "< 5 s"),
    "P8.7": ("Home = 1 request, deliver = 1 request", "1 / 1"),
    "P8.8": ("error rate", "< 0.1 %"),
}


def load_summaries(folder: Path):
    summaries = {}
    for path in sorted(folder.glob("*.json")):
        try:
            data = json.loads(path.read_text())
        except Exception as exc:  # noqa: BLE001
            print(f"skipping {path.name}: {exc}", file=sys.stderr)
            continue
        summaries[path.stem] = data
    return summaries


def metrics(summary):
    """k6's summary export: {metric name: {type, values: {...}, thresholds: {...}}}.

    Tagged sub-metrics appear as their own keys ("http_req_duration{name:home}").
    The numbers live under "values"; older exports keep them flat, so both work.
    """
    out = {}
    for key, value in summary.items():
        if not isinstance(value, dict):
            continue
        values = value.get("values")
        out[key] = values if isinstance(values, dict) else value
    return out


def find(m, needle):
    """Find a metric by name, preferring an exact match, then a tagged variant."""
    if needle in m:
        return m[needle]
    for key, value in m.items():
        if key.split("{")[0] == needle:
            return value
    for key, value in m.items():
        if needle in key:
            return value
    return None


def p95(metric):
    if not metric:
        return None
    for key in ("p(95)", "p95"):
        if key in metric:
            try:
                return float(metric[key])
            except (TypeError, ValueError):
                return None
    return None


def number(metric, key):
    if not metric:
        return None
    value = metric.get(key)
    if isinstance(value, (int, float)):
        return float(value)
    return None


def rate_of(metric):
    if not metric:
        return None
    for key in ("rate", "value"):
        if key in metric and isinstance(metric[key], (int, float)):
            return float(metric[key])
    passes = metric.get("passes")
    fails = metric.get("fails")
    if isinstance(passes, (int, float)) and isinstance(fails, (int, float)) and (passes + fails) > 0:
        return passes / (passes + fails)
    return None


def row(target, what, measured, status):
    return {"target": target, "what": what, "measured": measured, "status": status}


def build_rows(summaries, folder):
    rows = []

    # ---- P8.3 simple read p95 ------------------------------------------------
    read_p95 = None
    for summary in summaries.values():
        m = metrics(summary)
        # "simple read" is Home (the app's one request when it opens). Opening a route
        # is P8.5, not P8.3.
        value = p95(find(m, "http_req_duration{name:home}"))
        if value is None:
            value = p95(find(m, "http_req_duration"))
        if value is not None:
            read_p95 = value if read_p95 is None else max(read_p95, value)
    rows.append(row("P8.3", "simple read p95",
                    f"{read_p95:.0f} ms" if read_p95 is not None else "not measured",
                    ("PASS" if read_p95 is not None and read_p95 < 150 else "FAIL" if read_p95 is not None else "n/a")))

    # ---- P8.4 stop event p95 -------------------------------------------------
    event_p95 = None
    for summary in summaries.values():
        m = metrics(summary)
        value = p95(find(m, "http_req_duration{name:stop_event}"))
        if value is not None:
            event_p95 = value if event_p95 is None else max(event_p95, value)
    rows.append(row("P8.4", "stop event p95",
                    f"{event_p95:.0f} ms" if event_p95 is not None else "not measured",
                    ("PASS" if event_p95 is not None and event_p95 < 250 else "FAIL" if event_p95 is not None else "n/a")))

    # ---- P8.5 route open -----------------------------------------------------
    open_p95 = None
    for summary in summaries.values():
        m = metrics(summary)
        value = p95(find(m, "http_req_duration{name:open_route}"))
        if value is not None:
            open_p95 = value if open_p95 is None else max(open_p95, value)
    rows.append(row("P8.5", "route open (200 stops) p95",
                    f"{open_p95:.0f} ms" if open_p95 is not None else "not measured",
                    ("PASS" if open_p95 is not None and open_p95 < 800 else "FAIL" if open_p95 is not None else "n/a")))
    size = None
    for path in sorted(folder.glob("route-size*.json")):
        try:
            size = float(json.loads(path.read_text())["kbGzipped"])
        except Exception:  # noqa: BLE001
            size = None
    if size is None:
        for summary in summaries.values():
            m = metrics(summary)
            metric = find(m, "http_resp_size") or find(m, "http_req_bytes")
            value = number(metric, "avg")
            if value:
                size = value / 1024.0
    rows.append(row("P8.5", "route open (200 stops), gzipped",
                    f"{size:.1f} KB" if size is not None else "not measured (scripts/measure_route_open.py)",
                    ("PASS" if size is not None and size < 150 else "FAIL" if size is not None else "n/a")))

    # ---- P8.6 optimise -------------------------------------------------------
    opt_p95 = None
    opt_max = None
    for summary in summaries.values():
        m = metrics(summary)
        metric = find(m, "optimise_seconds")
        value = p95(metric)
        if value is not None:
            opt_p95 = value if opt_p95 is None else max(opt_p95, value)
        value = number(metric, "max")
        if value is not None:
            opt_max = value if opt_max is None else max(opt_max, value)
    measured = "not measured"
    status = "n/a"
    if opt_p95 is not None:
        measured = f"p95 {opt_p95:.2f} s, max {opt_max:.2f} s" if opt_max is not None else f"p95 {opt_p95:.2f} s"
        status = "PASS" if opt_max is not None and opt_max < 5 else "FAIL"
    rows.append(row("P8.6", "optimise 200 stops", measured, status))

    # ---- P8.7 requests per action -------------------------------------------
    per_action = {}
    for name, summary in summaries.items():
        if "route200" not in name:
            continue
        m = metrics(summary)
        iterations = number(find(m, "iterations"), "count") or 0
        home_count = number(find(m, "http_req_duration{name:home}"), "count") or 0
        event_count = number(find(m, "http_req_duration{name:stop_event}"), "count") or 0
        if iterations:
            per_action = {
                "home per iteration": home_count / iterations,
                "deliver per iteration": event_count / iterations,
                "iterations": iterations,
            }
    if per_action:
        home_ratio = per_action["home per iteration"]
        deliver_ratio = per_action["deliver per iteration"]
        rows.append(row("P8.7", "Home = 1 request, deliver = 1 request",
                        f"{home_ratio:.2f} / {deliver_ratio:.2f}",
                        "PASS" if home_ratio <= 1.01 and deliver_ratio <= 1.01 else "FAIL"))
    else:
        rows.append(row("P8.7", "Home = 1 request, deliver = 1 request", "not measured", "n/a"))
    rows.append(row("P8.7", "Home first paint", "not measured (needs a real phone)", "n/a"))

    # ---- P8.8 error rate, duplicates, lost events ---------------------------
    failed = None
    checks = None
    for summary in summaries.values():
        m = metrics(summary)
        value = rate_of(find(m, "http_req_failed"))
        if value is not None:
            failed = value if failed is None else max(failed, value)
        value = rate_of(find(m, "checks"))
        if value is not None:
            checks = value if checks is None else min(checks, value)
    rows.append(row("P8.8", "error rate",
                    f"{failed * 100:.3f} %" if failed is not None else "not measured",
                    ("PASS" if failed is not None and failed < 0.001 else "FAIL" if failed is not None else "n/a")))
    rows.append(row("P8.8", "zero duplicates, zero lost events",
                    f"checks {checks * 100:.2f} %" if checks is not None else "not measured",
                    ("PASS" if checks is not None and checks >= 0.999 else "FAIL" if checks is not None else "n/a")))
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("folder", nargs="?", default="infra/loadtest/results", help="folder with the k6 summaries")
    ap.add_argument("--markdown", help="write the table to this file")
    args = ap.parse_args()

    folder = Path(args.folder)
    if not folder.exists():
        print(f"No results folder {folder}. Nothing was run.", file=sys.stderr)
        return 1
    summaries = load_summaries(folder)
    if not summaries:
        print(f"No k6 summaries in {folder}.", file=sys.stderr)
        return 1
    rows = build_rows(summaries, folder)
    lines = ["| Target | What | Measured | Status |", "|---|---|---|---|"]
    for r in rows:
        lines.append(f"| {r['target']} | {r['what']} | {r['measured']} | {r['status']} |")
    table = "\n".join(lines)
    print(table)
    if args.markdown:
        Path(args.markdown).write_text(table + "\n")
    print(f"\n({len(summaries)} summary files read from {folder})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
