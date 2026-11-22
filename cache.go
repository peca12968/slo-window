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
	done   chan struct{}
	cancel context.CancelFunc
	result Result[V]
	err    error
}

type Cache[V any] struct {
	mu      sync.Mutex
	config  Config
	load    Loader[V]
	items   map[string]*list.Element
	order   list.List
	flights map[string]*flight[V]
	// Includes invalidated loaders that have not returned yet.
	activeLoads int
}

func New[V any](cfg Config, load Loader[V]) (*Cache[V], error) {
	if cfg.FreshFor <= 0 || cfg.StaleIfError < 0 || cfg.LoadTimeout <= 0 ||
		cfg.MaxEntries < 1 || cfg.MaxInFlight < 1 || load == nil {
		return nil, errors.New("cache: invalid durations, capacity, or loader")
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Cache[V]{config: cfg, load: load, items: make(map[string]*list.Element),
		flights: make(map[string]*flight[V])}, nil
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
			c.order.MoveToFront(item)
			c.mu.Unlock()
			return Result[V]{Value: stored.value, Source: Hit}, nil
		}
	}
	f := c.flights[key]
	if f == nil {
		if c.activeLoads >= c.config.MaxInFlight {
			c.mu.Unlock()
			return Result[V]{}, ErrBusy
		}
		loadCtx, cancel := context.WithTimeout(context.Background(), c.config.LoadTimeout)
		f = &flight[V]{done: make(chan struct{}), cancel: cancel}
		c.flights[key] = f
		c.activeLoads++
		go c.refresh(loadCtx, key, f)
	}
	c.mu.Unlock()

	select {
	case <-ctx.Done():
		return Result[V]{}, ctx.Err()
	case <-f.done:
		if err := ctx.Err(); err != nil {
			return Result[V]{}, err
		}
		return f.result, f.err
	}
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
		f.cancel()
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
	if c.flights[key] != f {
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
