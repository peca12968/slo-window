// Package cache provides a bounded, process-local read-through cache.
package cache

import (
	"container/list"
	"context"
	"errors"
	"sync"
	"time"
)

var ErrBusy = errors.New("cache: too many distinct loads in flight")

// ErrInvalidated means a write invalidated the unfinished load this caller had joined.
var ErrInvalidated = errors.New("cache: load invalidated")

type Source string

const (
	Hit    Source = "hit"
	Loaded Source = "loaded"
	Stale  Source = "stale"
)

type Result[V any] struct {
	Value  V
	Source Source
}

type Config struct {
	FreshFor     time.Duration
	StaleIfError time.Duration
	LoadTimeout  time.Duration
	MaxEntries   int
	MaxInFlight  int
	// Now controls entry age. LoadTimeout always uses a real context deadline.
	Now func() time.Time
}

type Loader[V any] func(context.Context, string) (V, error)

type entry[V any] struct {
	key        string
	value      V
	freshUntil time.Time
}

type flight[V any] struct {
	done          chan struct{}
	cancel        context.CancelFunc
	result        Result[V]
	err           error
	queued        *list.Element
	queuedWaiters int
}

type Cache[V any] struct {
	mu      sync.Mutex
	totals  Counters
	config  Config
	load    Loader[V]
	items   map[string]*list.Element
	order   list.List
	flights map[string]*flight[V]
	// Includes invalidated loaders that have not returned yet.
	activeLoads int
	pending     list.List // FIFO of distinct keys waiting for a loader slot.
	maxQueued   int
}

func New[V any](cfg Config, load Loader[V]) (*Cache[V], error) {
	return NewWithQueue(cfg, 0, load)
}

// NewWithQueue additionally admits up to maxQueued distinct waiting keys.
// LoadTimeout starts when dispatched. Get's context also covers time in the queue.
func NewWithQueue[V any](cfg Config, maxQueued int, load Loader[V]) (*Cache[V], error) {
	if cfg.FreshFor <= 0 || cfg.StaleIfError < 0 || cfg.LoadTimeout <= 0 ||
		cfg.MaxEntries < 1 || cfg.MaxInFlight < 1 || maxQueued < 0 || load == nil {
		return nil, errors.New("cache: invalid durations, capacity, or loader")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Cache[V]{config: cfg, load: load, items: make(map[string]*list.Element),
		flights: make(map[string]*flight[V]), maxQueued: maxQueued}, nil
}

// Get waits for the shared load for key. Cancelling ctx detaches only this waiter.
func (c *Cache[V]) Get(ctx context.Context, key string) (Result[V], error) {
	if err := ctx.Err(); err != nil {
		return Result[V]{}, err
	}
	c.mu.Lock()
	if item := c.items[key]; item != nil {
		stored := item.Value.(entry[V])
		if c.config.Now().Before(stored.freshUntil) {
			c.totals.Hits++
			c.order.MoveToFront(item)
			c.mu.Unlock()
			return Result[V]{Value: stored.value, Source: Hit}, nil
		}
	}
	f := c.flights[key]
	if f == nil {
		if c.activeLoads >= c.config.MaxInFlight && c.pending.Len() >= c.maxQueued {
			c.totals.BusyRejections++
			c.mu.Unlock()
			return Result[V]{}, ErrBusy
		}
		f = &flight[V]{done: make(chan struct{})}
		c.flights[key] = f
		if c.activeLoads < c.config.MaxInFlight {
			c.start(key, f)
		} else {
			f.queued = c.pending.PushBack(key)
		}
	} else {
		c.totals.SharedJoins++
	}
	if f.queued != nil {
		f.queuedWaiters++
	}
	c.mu.Unlock()

	select {
	case <-ctx.Done():
		c.leaveQueue(key, f)
		return Result[V]{}, ctx.Err()
	case <-f.done:
		if err := ctx.Err(); err != nil {
			return Result[V]{}, err
		}
		return f.result, f.err
	}
}

func (c *Cache[V]) leaveQueue(key string, f *flight[V]) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if f.queued == nil {
		return
	}
	f.queuedWaiters--
	if f.queuedWaiters == 0 {
		c.removeQueued(f)
		delete(c.flights, key)
	}
}

// All admission and dispatch operations run under mu.
func (c *Cache[V]) start(key string, f *flight[V]) {
	ctx, cancel := context.WithTimeout(context.Background(), c.config.LoadTimeout)
	f.cancel = cancel
	c.activeLoads++
	c.totals.LoadsStarted++
	go c.refresh(ctx, key, f)
}

func (c *Cache[V]) removeQueued(f *flight[V]) {
	c.pending.Remove(f.queued)
	f.queued = nil
}

// Invalidate forgets key and wakes waiters on its unfinished load with ErrInvalidated.
// Call it after the source write commits. An old loader can no longer publish its result.
func (c *Cache[V]) Invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if item := c.items[key]; item != nil {
		delete(c.items, key)
		c.order.Remove(item)
	}
	if f := c.flights[key]; f != nil {
		delete(c.flights, key)
		if f.queued != nil {
			c.removeQueued(f)
		} else {
			f.cancel()
		}
		f.err = ErrInvalidated
		close(f.done)
	}
}

func (c *Cache[V]) refresh(ctx context.Context, key string, f *flight[V]) {
	defer f.cancel()
	value, err := c.load(ctx, key)
	if deadline := ctx.Err(); deadline != nil {
		err = deadline
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	c.activeLoads--
	if first := c.pending.Front(); first != nil {
		nextKey := first.Value.(string)
		next := c.flights[nextKey]
		c.removeQueued(next)
		c.start(nextKey, next)
	}
	if c.flights[key] != f {
		c.totals.DiscardedLoads++
		return
	}
	now := c.config.Now()
	item := c.items[key]
	if err == nil {
		updated := entry[V]{key: key, value: value, freshUntil: now.Add(c.config.FreshFor)}
		if item != nil {
			item.Value = updated
			c.order.MoveToFront(item)
		} else {
			c.items[key] = c.order.PushFront(updated)
			if c.order.Len() > c.config.MaxEntries {
				victim := c.order.Back()
				delete(c.items, victim.Value.(entry[V]).key)
				c.order.Remove(victim)
			}
		}
		f.result = Result[V]{Value: value, Source: Loaded}
	} else {
		f.err = err
		if item != nil {
			stored := item.Value.(entry[V])
			if now.Before(stored.freshUntil.Add(c.config.StaleIfError)) {
				c.totals.StaleFallbacks++
				f.result = Result[V]{Value: stored.value, Source: Stale}
				f.err = nil
				c.order.MoveToFront(item)
			} else {
				delete(c.items, key)
				c.order.Remove(item)
			}
		}
	}
	delete(c.flights, key)
	close(f.done)
}
