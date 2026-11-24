package cache

import (
	"container/list"
	"errors"
)

// WeightStats reports the sum of the caller-defined weights for resident values.
// A zero Limit identifies a cache using only the entry-count limit.
type WeightStats struct {
	Limit          uint64
	Resident       uint64
	OversizedLoads uint64
}

// NewWithWeightLimit additionally limits total resident weight. weigh runs outside
// the cache lock and must support concurrent calls on different keys. A successful
// oversized load is returned to its waiters but is never admitted to the cache.
func NewWithWeightLimit[V any](cfg Config, maxQueued int, limit uint64, weigh func(string, V) uint64, load Loader[V]) (*Cache[V], error) {
	if limit == 0 || weigh == nil {
		return nil, errors.New("cache: positive weight limit and weight function required")
	}
	c, err := NewWithQueue(cfg, maxQueued, load)
	if err != nil {
		return nil, err
	}
	c.weigh = weigh
	c.weightStats.Limit = limit
	return c, nil
}

func (c *Cache[V]) WeightStats() WeightStats {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.weightStats
}

// removeEntry and admit run with mu held.
func (c *Cache[V]) removeEntry(item *list.Element) {
	stored := item.Value.(entry[V])
	c.weightStats.Resident -= stored.weight
	delete(c.items, stored.key)
	c.order.Remove(item)
}

func (c *Cache[V]) admit(next entry[V]) {
	item := c.items[next.key]
	if next.weight > c.weightStats.Limit {
		if item != nil {
			c.removeEntry(item)
		}
		c.weightStats.OversizedLoads++
		return
	}
	if item != nil {
		c.weightStats.Resident -= item.Value.(entry[V]).weight
		c.order.MoveToFront(item)
	}
	for c.weightStats.Resident > c.weightStats.Limit-next.weight || item == nil && c.order.Len() >= c.config.MaxEntries {
		c.removeEntry(c.order.Back())
	}
	if item == nil {
		c.items[next.key] = c.order.PushFront(next)
	} else {
		item.Value = next
	}
	c.weightStats.Resident += next.weight
}
