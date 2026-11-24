"""Summarize direct child coverage from binary OTLP trace export requests."""

import argparse
from collections import Counter, defaultdict
from dataclasses import dataclass
import json
from pathlib import Path
import sys

from google.protobuf.message import DecodeError
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest


@dataclass(frozen=True)
class Span:
    id: str
    parent: str | None
    service: str | None
    name: str
    start: int
    end: int
    links: tuple[tuple[str, str], ...] = ()
    dropped_links: int = 0
    host: str | None = None


def identifier(raw, size, label):
    if len(raw) != size or not any(raw):
        raise ValueError(f"invalid {label}, expected a nonzero {size}-byte identifier")
    return raw.hex()


def read_batches(paths):
    traces = defaultdict(dict)
    duplicates = 0
    for path in paths:
        try:
            request = ExportTraceServiceRequest.FromString(path.read_bytes())
            for resource in request.resource_spans:
                labels = {a.key: a.value.string_value for a in resource.resource.attributes
                          if a.key in ("service.name", "host.name") and a.value.HasField("string_value")}
                for scope in resource.scope_spans:
                    for raw in scope.spans:
                        trace = identifier(raw.trace_id, 16, "trace_id")
                        key = identifier(raw.span_id, 8, "span_id")
                        parent = identifier(raw.parent_span_id, 8, "parent_span_id") if raw.parent_span_id else None
                        if raw.end_time_unix_nano < raw.start_time_unix_nano:
                            raise ValueError(f"span {key} ends before it starts")
                        links = tuple(sorted((link.trace_id.hex(), link.span_id.hex()) for link in raw.links))
                        span = Span(key, parent, labels.get("service.name"), raw.name, raw.start_time_unix_nano,
                                    raw.end_time_unix_nano, links, raw.dropped_links_count, labels.get("host.name"))
                        previous = traces[trace].get(key)
                        if previous is None:
                            traces[trace][key] = span
                        elif previous == span:
                            duplicates += 1
                        else:
                            raise ValueError(f"conflicting span {key} in trace {trace}")
        except (OSError, DecodeError, ValueError) as error:
            raise ValueError(f"{path}: {error}") from error
    return traces, duplicates


def check_parents(trace, spans):
    checked = set()
    for key in spans:
        chain = set()
        while key in spans and key not in checked:
            if key in chain:
                raise ValueError(f"parent cycle at span {key} in trace {trace}")
            chain.add(key)
            key = spans[key].parent
        checked.update(chain)


def timing(parent, children):
    # Use half-open intervals. Combine simultaneous starts and ends before
    # counting the next interval, so touching children have zero overlap.
    changes = defaultdict(int)
    outside = 0
    for child in children:
        start = max(parent.start, child.start)
        end = min(parent.end, child.end)
        outside += child.end - child.start - max(0, end - start)
        if start < end:
            changes[start] += 1
            changes[end] -= 1
    active = covered = overlap = peak = 0
    last = parent.start
    for moment in sorted(changes):
        elapsed = moment - last
        if active:
            covered += elapsed
        if active >= 2:
            overlap += elapsed
        active += changes[moment]
        peak = max(peak, active)
        last = moment
    duration = parent.end - parent.start
    return {"duration_ns": duration, "covered_ns": covered, "uncovered_ns": duration - covered,
            "overlap_ns": overlap, "peak_children": peak, "child_time_outside_ns": outside}


def summarize(trace, spans):
    check_parents(trace, spans)
    children = defaultdict(list)
    missing = set()
    roots = []
    for span in spans.values():
        if span.parent is None:
            roots.append(span.id)
        elif span.parent not in spans:
            missing.add(span.parent)
        else:
            children[span.parent].append(span)
    rows = []
    for span in sorted(spans.values(), key=lambda s: (s.start, s.id)):
        rows.append({"span_id": span.id, "parent_span_id": span.parent, "service": span.service,
                     "name": span.name, **timing(span, children[span.id])})
    return {"trace_id": trace, "root_ids": sorted(roots), "missing_parent_ids": sorted(missing), "spans": rows}


def read_clock_bounds(path):
    report = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(report, dict) or report.get("consistent") is not True or not isinstance(report.get("offset_pairs_us"), list):
        raise ValueError("expected a consistent Clock Bracket --pairs report")
    bounds = {}
    for row in report["offset_pairs_us"]:
        if not isinstance(row, dict) or not all(isinstance(row.get(k), str) and row[k].strip() for k in ("from", "to")):
            raise ValueError("invalid clock pair hosts")
        if not all(k in row and (row[k] is None or type(row[k]) is int) for k in ("lower_us", "upper_us")):
            raise ValueError("invalid clock pair bounds")
        key, lo, hi = (row["from"], row["to"]), row["lower_us"], row["upper_us"]
        if key in bounds or (lo is not None and hi is not None and lo > hi) or (key[0] == key[1] and (lo, hi) != (0, 0)):
            raise ValueError("duplicate or inconsistent clock pair")
        bounds[key] = (lo, hi)
    return bounds


def corrected_delta(source, target, bounds):
    pair = (target.host if target else None, source.host)
    result = {"from_host": pair[0], "to_host": pair[1], "lower_ns": None, "upper_ns": None}
    if target is None:
        state = "missing_span"
    elif not all(pair):
        state = "missing_host"
    elif pair not in bounds:
        state = "unknown_pair"
    else:
        lo, hi = bounds[pair]
        raw = source.start - target.end
        result["lower_ns"] = raw + lo * 1000 if lo is not None else None
        result["upper_ns"] = raw + hi * 1000 if hi is not None else None
        state = "bounded" if lo is not None and hi is not None else "one_sided"
        if lo is None and hi is None:
            state = "unbounded"
    return {**result, "state": state}


def link_report(traces, bounds=None):
    edges = []
    dropped = 0
    for trace, spans in sorted(traces.items()):
        for source in sorted(spans.values(), key=lambda span: span.id):
            dropped += source.dropped_links
            for (tid, sid), count in sorted(Counter(source.links).items()):
                target = traces.get(tid, {}).get(sid)
                state = "resolved" if target else "missing"
                if len(tid) != 32 or len(sid) != 16 or not int(tid, 16) or not int(sid, 16):
                    state = "unaddressable"
                edges.append({"trace_id": trace, "span_id": source.id, "name": source.name,
                              "linked_trace_id": tid, "linked_span_id": sid, "count": count, "state": state,
                              "linked_name": target.name if target else None,
                              "start_minus_linked_end_ns": source.start - target.end if target else None})
                if bounds is not None:
                    edges[-1]["clock_adjusted"] = corrected_delta(source, target, bounds)
    return {"edges": edges, "dropped_links": dropped}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("batches", type=Path, nargs="+", help="uncompressed binary OTLP export request bodies")
    parser.add_argument("--links", action="store_true", help="resolve span links across the supplied batches")
    parser.add_argument("--clock-bounds", type=Path, help="include linked-span timing with calibrated host offset bounds")
    args = parser.parse_args()
    try:
        bounds = read_clock_bounds(args.clock_bounds) if args.clock_bounds else None
        traces, duplicates = read_batches(args.batches)
        reports = [summarize(key, traces[key]) for key in sorted(traces)]
    except (ValueError, OSError) as error:
        print(error, file=sys.stderr)
        return 2
    result = {"duplicate_spans": duplicates, "traces": reports}
    if args.links or bounds is not None:
        result["links"] = link_report(traces, bounds)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
