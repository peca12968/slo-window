"""Replay timestamped requests through a bounded FIFO service."""
import argparse
from collections import Counter, OrderedDict
import csv
from dataclasses import asdict, dataclass
from heapq import heappop, heappush
import json
from pathlib import Path


@dataclass(frozen=True)
class Request:
    id: str
    arrival_ms: int
    service_ms: int
    patience_ms: int

    def __post_init__(self):
        if not isinstance(self.id, str) or not self.id.strip():
            raise ValueError("expected a nonempty request id")
        if (any(type(v) is not int for v in (self.arrival_ms, self.service_ms, self.patience_ms))
                or min(self.arrival_ms, self.patience_ms) < 0 or self.service_ms < 1):
            raise ValueError("invalid arrival, service or patience")


@dataclass(frozen=True)
class Outcome:
    id: str
    status: str
    start_ms: int | None
    end_ms: int
    wait_ms: int


def csv_rows(path, fields):
    with path.open(encoding="utf-8-sig", newline="") as stream:
        reader = csv.DictReader(stream, strict=True)
        if sorted(reader.fieldnames or []) != sorted(fields):
            raise ValueError("expected CSV columns " + ", ".join(fields))
        for row in reader:
            if None in row:
                raise ValueError(f"line {reader.line_num}: extra column")
            yield reader.line_num, row


def read_trace(path):
    fields = ("id", "arrival_ms", "service_ms", "patience_ms")
    trace = []
    for line, row in csv_rows(path, fields):
        try:
            trace.append(Request(row["id"], *(int(row[key]) for key in fields[1:])))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"line {line}: invalid request id or millisecond value") from exc
    return trace


@dataclass(frozen=True)
class Staffing:
    at_ms: int
    workers: int

    def __post_init__(self):
        if any(type(v) is not int or v < 0 for v in (self.at_ms, self.workers)):
            raise ValueError("staffing times and worker targets must be nonnegative integers")


def read_staffing(path):
    staffing = []
    for line, row in csv_rows(path, ("at_ms", "workers")):
        try:
            staffing.append(Staffing(int(row["at_ms"]), int(row["workers"])))
        except (TypeError, ValueError) as exc:
            raise ValueError(f"line {line}: invalid staffing change") from exc
    return staffing


def replay(trace, workers, queue_limit):
    if type(workers) is not int or workers < 1:
        raise ValueError("workers must be positive")
    return {"workers": workers, **_replay(trace, workers, [], queue_limit)}


def replay_staffing(trace, staffing, queue_limit):
    staffing = list(staffing)
    if not staffing or staffing[0].at_ms != 0:
        raise ValueError("staffing must begin at 0 ms")
    if any(a.at_ms >= b.at_ms for a, b in zip(staffing, staffing[1:])):
        raise ValueError("staffing times must be strictly increasing")
    return {"staffing": [asdict(row) for row in staffing],
            **_replay(trace, staffing[0].workers, staffing[1:], queue_limit)}


def _replay(trace, target, changes, queue_limit):
    if type(queue_limit) is not int or queue_limit < 0:
        raise ValueError("queue limit must be nonnegative")
    arrivals = sorted(trace, key=lambda r: r.arrival_ms)
    if len({r.id for r in arrivals}) != len(arrivals):
        raise ValueError("duplicate request id")
    pending = OrderedDict()
    deadlines, completions = [], []
    outcomes = {}
    index = peak_queue = 0
    change_index = previous = target_time = drain_time = 0

    def start(request, now):
        end = now + request.service_ms
        outcomes[request.id] = Outcome(request.id, "served", now, end, now - request.arrival_ms)
        heappush(completions, end)

    while index < len(arrivals) or pending or completions:
        # Dispatched requests can leave obsolete deadlines behind.
        while deadlines and deadlines[0][1] not in pending:
            heappop(deadlines)
        times = []
        if index < len(arrivals):
            times.append(arrivals[index].arrival_ms)
        if completions:
            times.append(completions[0])
        if deadlines:
            times.append(deadlines[0][0])
        if change_index < len(changes):
            times.append(changes[change_index].at_ms)
        now = min(times)
        # Integrate the previous interval, clipped to the observation window.
        elapsed = max(0, now - max(previous, arrivals[0].arrival_ms))
        target_time += target * elapsed
        drain_time += max(0, len(completions) - target) * elapsed
        previous = now

        while deadlines and deadlines[0][0] <= now:
            _, name = heappop(deadlines)
            request = pending.pop(name, None)
            if request is not None:
                outcomes[name] = Outcome(name, "timed_out", None, now, now - request.arrival_ms)
        while completions and completions[0] <= now:
            heappop(completions)
        if change_index < len(changes) and changes[change_index].at_ms == now:
            target = changes[change_index].workers
            change_index += 1
        while pending and len(completions) < target:
            _, request = pending.popitem(last=False)
            start(request, now)
        while index < len(arrivals) and arrivals[index].arrival_ms == now:
            request = arrivals[index]
            index += 1
            if len(completions) < target:
                start(request, now)
            elif request.patience_ms == 0:
                outcomes[request.id] = Outcome(request.id, "timed_out", None, now, 0)
            elif len(pending) == queue_limit:
                outcomes[request.id] = Outcome(request.id, "queue_full", None, now, 0)
            else:
                pending[request.id] = request
                heappush(deadlines, (now + request.patience_ms, request.id))
                peak_queue = max(peak_queue, len(pending))
    rows = [outcomes[r.id] for r in arrivals]
    counts = Counter(r.status for r in rows)
    waits = sorted(r.wait_ms for r in rows if r.status == "served")
    window = max(r.end_ms for r in rows) - arrivals[0].arrival_ms if rows else 0
    busy = sum(r.end_ms - r.start_ms for r in rows if r.start_ms is not None)
    return {"queue_limit": queue_limit, "served": counts["served"],
            "timed_out": counts["timed_out"], "queue_full": counts["queue_full"],
            "p95_served_wait_ms": waits[(95 * len(waits) - 1) // 100] if waits else None,
            "peak_queue": peak_queue, "busy_worker_ms": busy, "window_ms": window,
            "target_worker_ms": target_time, "draining_worker_ms": drain_time,
            "allocated_worker_ms": target_time + drain_time,
            "outcomes": [asdict(r) for r in rows]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", type=Path)
    parser.add_argument("--workers", nargs="+", type=int, default=[], help="fixed worker counts to compare")
    parser.add_argument("--staffing", type=Path, help="also replay a CSV of at_ms,workers targets")
    parser.add_argument("--queue", required=True, type=int, metavar="SLOTS")
    parser.add_argument("--details", action="store_true", help="include per-request decisions and timestamps")
    args = parser.parse_args()
    if not args.workers and args.staffing is None:
        parser.error("supply --workers or --staffing")
    try:
        trace = read_trace(args.trace)
        reports = [replay(trace, workers, args.queue) for workers in dict.fromkeys(args.workers)]
        if args.staffing is not None:
            reports.append(replay_staffing(trace, read_staffing(args.staffing), args.queue))
        if not args.details:
            for result in reports:
                del result["outcomes"]
    except (ValueError, OSError, csv.Error) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(reports, indent=2))


if __name__ == "__main__":
    main()
