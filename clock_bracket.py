"""Bound cross-host durations using recorded sends and receives with constant clock offsets."""
import argparse
from dataclasses import dataclass
import json
from pathlib import Path


@dataclass(frozen=True)
class Edge:
    start: str
    end: str
    weight: int
    message: str
    bound: str

    def evidence(self):
        return {"message": self.message, "bound": self.bound, "from": self.start,
                "to": self.end, "upper_offset_difference_us": self.weight}


def relax(hosts, edges, source=None):
    # With no source, an implicit zero-weight super-source reaches every host.
    distance = {h: 0 for h in hosts} if source is None else {source: 0}
    previous = {}
    for _ in hosts:
        changed = None
        for edge in edges:
            if edge.start not in distance:
                continue
            bound = distance[edge.start] + edge.weight
            if edge.end not in distance or bound < distance[edge.end]:
                distance[edge.end] = bound
                previous[edge.end] = edge
                changed = edge.end
        if changed is None:
            return distance, previous, []
    # A vertex updated in pass |V| is reachable from a negative cycle.
    node = changed
    for _ in hosts:
        node = previous[node].start
    cycle = []
    end = node
    while True:
        edge = previous[node]
        cycle.append(edge)
        node = edge.start
        if node == end:
            return distance, previous, list(reversed(cycle))


def witness(previous, source, destination):
    steps = []
    while destination != source:
        if destination not in previous:
            return None
        step = previous[destination]
        steps.append(step.evidence())
        destination = step.start
    return list(reversed(steps))


def rows(plan, field, hosts):
    records = plan.get(field, [])
    if not isinstance(records, list):
        raise ValueError(f"expected a list of {field}")
    used = set()
    for row in records:
        if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not row["id"].strip() or row["id"] in used:
            raise ValueError(f"expected unique nonempty {field} IDs")
        for key in ("from", "to"):
            if not isinstance(row.get(key), str) or row[key] not in hosts:
                raise ValueError(f"{row['id']}: unknown {key} host")
        used.add(row["id"])
        yield row


def number(row, field):
    value = row.get(field)
    if type(value) is not int:
        raise ValueError(f"{row['id']}: expected integer {field}")
    return value


def solve(plan, explain=False):
    hosts = plan.get("hosts") if isinstance(plan, dict) else None
    if not isinstance(hosts, list) or not hosts or not all(isinstance(h, str) and h.strip() for h in hosts):
        raise ValueError("expected nonempty list of host names")
    if len(set(hosts)) != len(hosts) or plan.get("reference") not in hosts:
        raise ValueError("expected unique hosts including the reference")
    edges = []
    for m in rows(plan, "messages", hosts):
        # Latency = receive_local - send_local + offset[to] - offset[from].
        delta = number(m, "receive_us") - number(m, "send_us")
        minimum = number(m, "min_us") if "min_us" in m else 0
        if minimum < 0:
            raise ValueError(f"{m['id']}: min_us must be nonnegative")
        edges.append(Edge(m["to"], m["from"], delta - minimum, m["id"], "min_us"))
        if "max_us" in m:
            maximum = number(m, "max_us")
            if maximum < minimum:
                raise ValueError(f"{m['id']}: max_us is below min_us")
            edges.append(Edge(m["from"], m["to"], maximum - delta, m["id"], "max_us"))
    queries = [(q, number(q, "end_us") - number(q, "start_us")) for q in rows(plan, "queries", hosts)]
    _, _, cycle = relax(hosts, edges)
    if cycle:
        return {"consistent": False, "cycle": [edge.evidence() for edge in cycle],
                "cycle_weight_us": sum(edge.weight for edge in cycle)}
    # A search from the reference on the reversed edges bounds every return path.
    reference = plan["reference"]
    cache = {reference: relax(hosts, edges, reference)}
    reverse = [Edge(e.end, e.start, e.weight, e.message, e.bound) for e in edges]
    back, _, _ = relax(hosts, reverse, reference)
    offsets = {h: {"lower_us": -back[h] if h in back else None, "upper_us": cache[reference][0].get(h)} for h in hosts}

    def bound(a, b):
        if b == reference and not explain:
            return back.get(a)
        if a not in cache:
            cache[a] = relax(hosts, edges, a)
        return cache[a][0].get(b)

    comparisons = []
    for q, delta in queries:
        upper = bound(q["from"], q["to"])
        inverse = bound(q["to"], q["from"])
        result = {"id": q["id"], "lower_us": delta - inverse if inverse is not None else None,
                  "upper_us": delta + upper if upper is not None else None}
        if explain:
            result["local_delta_us"] = delta
            result["upper_path"] = witness(cache[q["from"]][1], q["from"], q["to"])
            result["inverse_path"] = witness(cache[q["to"]][1], q["to"], q["from"])
        comparisons.append(result)
    return {"consistent": True, "reference": reference, "offsets": offsets, "queries": comparisons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument("--explain", action="store_true", help="show message constraints supporting each query bound")
    args = parser.parse_args()
    try:
        report = solve(json.loads(args.capture.read_text(encoding="utf-8-sig")), args.explain)
    except (OSError, ValueError) as error:
        parser.exit(2, f"{error}\n")
    print(json.dumps(report, indent=2))
    return int(not report["consistent"])


if __name__ == "__main__":
    raise SystemExit(main())
