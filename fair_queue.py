"""Cost-weighted waiting queues with deadline removal before dispatch."""
from collections import OrderedDict


class FairQueue:
    def __init__(self, quanta, jobs, request_ids):
        if not quanta or any(not isinstance(k, str) or not k.strip() or type(v) is not int or v < 1
                             for k, v in quanta.items()):
            raise ValueError("expected positive integer quanta per tenant")
        if set(jobs) != set(request_ids):
            raise ValueError("fair policy must assign every trace request exactly once")
        self.quanta = dict(quanta)
        self.jobs = {}
        for name, entry in jobs.items():
            if (not isinstance(entry, dict) or not isinstance(entry.get("tenant"), str)
                    or entry["tenant"] not in quanta or type(entry.get("cost")) is not int or entry["cost"] < 1):
                raise ValueError(f"invalid tenant or estimated cost for {name}")
            self.jobs[name] = (entry["tenant"], entry["cost"])
        self.lanes = {tenant: OrderedDict() for tenant in quanta}
        self.credit = dict.fromkeys(quanta, 0)
        self.active = OrderedDict()
        self.continuing = None

    def add(self, name):
        tenant, cost = self.jobs[name]
        queue = self.lanes[tenant]
        if not queue:
            self.active[tenant] = None
        queue[name] = cost

    def remove(self, name):
        tenant, _ = self.jobs[name]
        queue = self.lanes[tenant]
        del queue[name]
        if not queue:
            del self.active[tenant]
            self.credit[tenant] = 0
            if self.continuing == tenant:
                self.continuing = None

    def take(self):
        misses = 0
        while self.active:
            tenant = next(iter(self.active))
            queue = self.lanes[tenant]
            name, cost = next(iter(queue.items()))
            if self.continuing != tenant:
                self.credit[tenant] += self.quanta[tenant]
            if cost <= self.credit[tenant]:
                self.credit[tenant] -= cost
                self.continuing = tenant
                self.remove(name)
                return name
            self.continuing = None
            self.active.move_to_end(tenant)
            misses += 1
            if misses == len(self.active):
                skip = min((next(iter(self.lanes[t].values())) - self.credit[t] - 1) // self.quanta[t]
                           for t in self.active)
                for t in self.active:
                    self.credit[t] += skip * self.quanta[t]
                misses = 0
        raise IndexError("empty waiting queue")
