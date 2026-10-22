"""Summarise `wrangler tail --format json` output by route (session 01, throwaway).

  python -I tailstats.py <tail.jsonl>

Groups by method + path, keeping the first two '-'-separated parts of the key segment, so
`/put-check/B-thumb-x` and `/put-check/B-hd2560-x` are separate rows. Prints outcome counts and
cpuTime / wallTime p50, p95 and max per row.
"""

import collections
import json
import math
import sys


def pct(xs, p):
    s = sorted(xs)
    return s[min(len(s) - 1, math.ceil(p / 100 * len(s)) - 1)]


def events(text):
    dec = json.JSONDecoder()
    i = 0
    while text[i:].strip():
        s = text[i:].lstrip()
        obj, n = dec.raw_decode(s)
        i = len(text) - len(s) + n
        yield obj


def route(url):
    path, _, query = url.split(".workers.dev", 1)[-1].partition("?")
    parts = path.split("/")
    if len(parts) > 2:
        parts[2] = "-".join(parts[2].split("-")[:2])
    q = "&".join(x for x in query.split("&") if x and not x.startswith("sha256"))
    return "/".join(parts) + (f"?{q}" if q else "")


def main(path):
    rows = collections.defaultdict(list)
    for e in events(open(path, encoding="utf-8").read()):
        req = (e.get("event") or {}).get("request") or {}
        rows[f"{req.get('method')} {route(req.get('url', ''))}"].append(e)
    for name, evs in sorted(rows.items()):
        cpu = [e["cpuTime"] for e in evs]
        wall = [e["wallTime"] for e in evs]
        ok = [e for e in evs if e["outcome"] == "ok"]
        okcpu = [e["cpuTime"] for e in ok] or [0]
        print(
            json.dumps(
                {
                    "route": name,
                    "n": len(evs),
                    "outcomes": dict(collections.Counter(e["outcome"] for e in evs)),
                    "cpu_p50": pct(cpu, 50),
                    "cpu_p95": pct(cpu, 95),
                    "cpu_max": max(cpu),
                    "ok_cpu_p50": pct(okcpu, 50),
                    "ok_cpu_p95": pct(okcpu, 95),
                    "wall_p50": pct(wall, 50),
                    "wall_p95": pct(wall, 95),
                }
            )
        )


if __name__ == "__main__":
    main(sys.argv[1])
