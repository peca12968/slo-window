export type Job = { tenant: string; id: string; cost: number };
type Link = { job: Job; next?: Link };
type Tenant = { quantum: bigint; credit: bigint; head?: Link; tail?: Link };

/** Deficit round robin with FIFO jobs and integer cost units. */
export class Scheduler {
  private tenants = new Map<string, Tenant>();
  private active = new Map<string, Tenant>();
  private continuing = false;

  constructor(quanta: Record<string, number>) {
    if (!quanta || typeof quanta !== "object" || Array.isArray(quanta) || !Object.keys(quanta).length) {
      throw new Error("Expected a nonempty tenant-to-quantum object");
    }
    for (const [id, quantum] of Object.entries(quanta)) {
      if (!id.trim() || !Number.isSafeInteger(quantum) || quantum < 1) {
        throw new Error("Expected tenant names and positive safe-integer quanta");
      }
      this.tenants.set(id, { quantum: BigInt(quantum), credit: 0n });
    }
  }

  enqueue(job: Job): void {
    const tenant = this.tenants.get(job.tenant);
    if (!tenant || typeof job.id !== "string" || !job.id.trim() ||
        !Number.isSafeInteger(job.cost) || job.cost < 1) {
      throw new Error("Invalid tenant, job ID or job cost");
    }
    const link: Link = { job: { tenant: job.tenant, id: job.id, cost: job.cost } };
    if (tenant.tail) tenant.tail.next = link;
    else {
      tenant.head = link;
      this.active.set(job.tenant, tenant);
    }
    tenant.tail = link;
  }

  next(): Job | undefined {
    let misses = 0;
    while (this.active.size) {
      const [id, tenant] = this.active.entries().next().value!;
      const head = tenant.head!;
      if (!this.continuing) tenant.credit += tenant.quantum;
      const cost = BigInt(head.job.cost);
      if (cost <= tenant.credit) {
        tenant.credit -= cost;
        tenant.head = head.next;
        this.continuing = Boolean(tenant.head);
        if (!tenant.head) {
          tenant.credit = 0n;
          tenant.tail = undefined;
          this.active.delete(id);
        }
        return head.job;
      }
      this.continuing = false;
      this.active.delete(id);
      this.active.set(id, tenant);
      if (++misses === this.active.size) {
        // All heads are unaffordable. Skip only whole rounds that cannot emit a job.
        let skip: bigint | undefined;
        for (const lane of this.active.values()) {
          const rounds = (BigInt(lane.head!.job.cost) - lane.credit - 1n) / lane.quantum;
          if (skip === undefined || rounds < skip) skip = rounds;
        }
        if (skip !== undefined && skip > 0n) {
          for (const lane of this.active.values()) lane.credit += skip * lane.quantum;
        }
        misses = 0;
      }
    }
    return undefined;
  }
}
