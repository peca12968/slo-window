package cache

// Counters accumulate for the life of one cache instance.
type Counters struct {
	Hits           uint64 // Reads served immediately from a fresh entry.
	SharedJoins    uint64 // Readers joining existing queued or active work, even if they later cancel.
	BusyRejections uint64 // Get calls rejected because both execution and waiting slots were full.
	LoadsStarted   uint64 // Dispatched source calls, including calls later invalidated.
	DiscardedLoads uint64 // Invalidated source calls that have returned and been discarded.
	StaleFallbacks uint64 // Failed loads resolved with stale data, counted once per shared load.
	CooldownReads  uint64 // Individual reads served stale before the next retry is due.
}

// Stats captures cumulative counts and current occupancy at the same instant.
type Stats struct {
	Counters
	Entries     int // Resident keys, including entries whose freshness period has elapsed.
	ActiveLoads int // Occupied execution slots, including invalidated calls still running.
	QueuedKeys  int // Distinct keys waiting for an execution slot.
}

// Stats returns an independent, constant-time snapshot without exposing keys or values.
func (c *Cache[V]) Stats() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return Stats{
		Counters:    c.totals,
		Entries:     len(c.items),
		ActiveLoads: c.activeLoads,
		QueuedKeys:  c.pending.Len(),
	}
}
