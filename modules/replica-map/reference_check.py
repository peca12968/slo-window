"""Check CLI transfer plans against an independent per-ticket placement and inventory."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys


def varint(number):
    result = bytearray()
    while number >= 128:
        result.append(128 + number % 128)
        number //= 128
    result.append(number)
    return bytes(result)


def owners(topology, key):
    tickets = []
    key = key.encode("utf-8")
    for node in topology["nodes"]:
        ident = node["id"].encode("utf-8")
        prefix = varint(len(key)) + key + varint(len(ident)) + ident
        for i in range(node["weight"]):
            digest = hashlib.sha256(prefix + varint(i)).digest()
            tickets.append((-int.from_bytes(digest, "big"), node["id"], node["zone"]))
    zones = set()
    result = []
    for _, ident, zone in sorted(tickets):
        if zone not in zones:
            result.append(ident)
            zones.add(zone)
        if len(result) == topology["copies"]:
            break
    return result


def check(binary, scenario, offline):
    args = [binary]
    for node in offline:
        args += ["-unavailable", node]
    report = json.loads(subprocess.check_output(args, input=json.dumps(scenario), encoding="utf-8"))
    expected = []
    totals = Counter()
    for obj in scenario["objects"]:
        key, size = obj["key"], obj["bytes"]
        old = owners(scenario["before"], key)
        target = owners(scenario["after"], key)
        ready = [node for node in old if node not in offline]
        missing = [node for node in target if node not in ready]
        source = ready[0] if ready else None
        for node in missing:
            expected.append({"key": key, "bytes": size, "from": source, "to": node})
        totals["objects"] += 1
        totals["primary_changes"] += old[0] != target[0]
        totals["primary_changes_without_copy"] += old[0] != target[0] and not missing
        totals["copy_bytes"] += size * len(missing)
        totals["origin_bytes"] += size * len(missing) if not ready else 0
    assert report["transfers"] == expected
    for name, value in totals.items():
        assert report[name] == value, (name, report[name], value)
    return totals


def main(binary):
    sample = json.loads(Path(__file__).with_name("examples").joinpath("retire.json").read_text())
    for offline in [[], ["north-a", "east-a"]]:
        totals = check(binary, sample, offline)
        print(f"retire {offline}: {dict(totals)}")
    rng = random.Random(12968)
    names = ["台北", "edge-A", "a" * 130, "edge-B", "west", "zone/new"]
    for case in range(80):
        def topology():
            nodes = [{"id": name, "zone": "z" + str(i % 3), "weight": rng.randint(1, 4)}
                     for i, name in enumerate(names) if rng.randrange(4)]
            if not nodes:
                nodes.append({"id": names[0], "zone": "z0", "weight": 1})
            rng.shuffle(nodes)
            return {"nodes": nodes, "copies": rng.randint(1, len({n["zone"] for n in nodes}))}
        before, after = topology(), topology()
        offline = [n["id"] for n in before["nodes"] if n["id"] not in {m["id"] for m in after["nodes"]}
                   and rng.randrange(2)]
        objects = [{"key": f"{case}-{i}-" + "樣" * i, "bytes": rng.randrange(3000)} for i in range(24)]
        check(binary, {"before":before,"after":after,"objects":objects}, offline)
    print("verified 80 topology changes and 1920 object placements against independent ticket ordering")


if __name__ == "__main__":
    main(str(Path(sys.argv[1]).resolve()))
