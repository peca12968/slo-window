package cache

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

type clock struct{ seconds atomic.Int64 }

func (c *clock) now() time.Time { return time.Unix(c.seconds.Load(), 0) }

func settings(clock *clock) Config {
	return Config{FreshFor: 10 * time.Second, StaleIfError: 5 * time.Second, LoadTimeout: 5 * time.Second,
		MaxEntries: 2, MaxInFlight: 2, Now: clock.now}
}

func mustCache(t *testing.T, cfg Config, loader Loader[string]) *Cache[string] {
	t.Helper()
	c, err := New(cfg, loader)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func get(t *testing.T, c *Cache[string], key string, want Source) string {
	t.Helper()
	result, err := c.Get(context.Background(), key)
	if err != nil || result.Source != want {
		t.Fatalf("Get(%q) = %+v, %v; want %s", key, result, err, want)
	}
	return result.Value
}

// Done is consulted when a caller has already acquired or joined its flight.
// This lets the test open the loader gate only after all twelve callers are waiting.
type observed struct {
	context.Context
	joined chan<- struct{}
}

func (o observed) Done() <-chan struct{} { o.joined <- struct{}{}; return o.Context.Done() }

func take[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case v := <-ch:
		return v
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for synchronization")
	}
	var zero T
	return zero
}

func TestBurstSharesOneFlight(t *testing.T) {
	var calls atomic.Int64
	gate := make(chan struct{})
	c := mustCache(t, settings(&clock{}), func(ctx context.Context, key string) (string, error) {
		calls.Add(1)
		select {
		case <-gate:
			return key, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	})
	joined := make(chan struct{}, 12)
	results := make(chan Result[string], 12)
	for range 12 {
		go func() { v, _ := c.Get(observed{context.Background(), joined}, "sku"); results <- v }()
	}
	for range 12 {
		take(t, joined)
	}
	close(gate)
	for range 12 {
		if got := take(t, results); got != (Result[string]{"sku", Loaded}) {
			t.Fatal(got)
		}
	}
	get(t, c, "sku", Hit)
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
}

func TestCancelFirstWaiterLeavesOtherReadersAndCacheIntact(t *testing.T) {
	gate := make(chan struct{})
	c := mustCache(t, settings(&clock{}), func(ctx context.Context, key string) (string, error) {
		select {
		case <-gate:
			return "ready", nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	})
	joined := make(chan struct{}, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cancelled := make(chan error, 1)
	go func() { _, err := c.Get(observed{ctx, joined}, "sku"); cancelled <- err }()
	take(t, joined)
	remaining := make(chan Result[string], 1)
	go func() { v, _ := c.Get(observed{context.Background(), joined}, "sku"); remaining <- v }()
	take(t, joined)
	cancel()
	if err := take(t, cancelled); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	close(gate)
	if v := take(t, remaining); v.Value != "ready" || v.Source != Loaded {
		t.Fatal(v)
	}
	get(t, c, "sku", Hit)
}

func TestGraceUsesLastSuccessfulLoadAndEndsExactlyAtBoundary(t *testing.T) {
	clk := &clock{}
	errOffline := errors.New("offline")
	var calls int
	c := mustCache(t, settings(clk), func(context.Context, string) (string, error) {
		calls++
		if calls == 1 {
			return "v1", nil
		}
		return "", errOffline
	})
	get(t, c, "sku", Loaded)
	clk.seconds.Store(9)
	get(t, c, "sku", Hit)
	for _, second := range []int64{10, 14} {
		clk.seconds.Store(second)
		if get(t, c, "sku", Stale) != "v1" {
			t.Fatal("lost value")
		}
	}
	clk.seconds.Store(15)
	if _, err := c.Get(context.Background(), "sku"); !errors.Is(err, errOffline) {
		t.Fatal(err)
	}
	if calls != 4 {
		t.Fatal(calls)
	}
}

func TestSlowFailureCannotServeAnEntryThatExpiredDuringRefresh(t *testing.T) {
	clk := &clock{}
	var version atomic.Int64
	gate := make(chan struct{})
	started := make(chan struct{})
	c := mustCache(t, settings(clk), func(context.Context, string) (string, error) {
		if version.Add(1) == 1 {
			return "v1", nil
		}
		close(started)
		<-gate
		return "", errors.New("unavailable")
	})
	get(t, c, "sku", Loaded)
	clk.seconds.Store(12)
	result := make(chan error, 1)
	go func() { _, err := c.Get(context.Background(), "sku"); result <- err }()
	take(t, started)
	clk.seconds.Store(16)
	close(gate)
	if err := take(t, result); err == nil {
		t.Fatal("served expired data")
	}
}

func TestLimitAppliesToDistinctFlightsAndReleasesCapacity(t *testing.T) {
	cfg := settings(&clock{})
	cfg.MaxInFlight = 1
	gate := make(chan struct{})
	c := mustCache(t, cfg, func(ctx context.Context, key string) (string, error) {
		select {
		case <-gate:
			return key, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	})
	joined := make(chan struct{}, 2)
	results := make(chan error, 2)
	for range 2 {
		go func() { _, err := c.Get(observed{context.Background(), joined}, "busy"); results <- err }()
		take(t, joined)
	}
	if _, err := c.Get(context.Background(), "other"); !errors.Is(err, ErrBusy) {
		t.Fatal(err)
	}
	close(gate)
	for range 2 {
		if err := take(t, results); err != nil {
			t.Fatal(err)
		}
	}
	get(t, c, "other", Loaded)
}

func TestLRUEvictionUsesHitRecency(t *testing.T) {
	c := mustCache(t, settings(&clock{}), func(_ context.Context, key string) (string, error) { return key, nil })
	get(t, c, "a", Loaded)
	get(t, c, "b", Loaded)
	get(t, c, "a", Hit)
	get(t, c, "c", Loaded)
	get(t, c, "a", Hit)
	get(t, c, "b", Loaded)
}

func TestRecoveryReplacesFallbackAndResetsItsLifetime(t *testing.T) {
	clk := &clock{}
	var version atomic.Int64
	c := mustCache(t, settings(clk), func(context.Context, string) (string, error) {
		switch version.Add(1) {
		case 1:
			return "old", nil
		case 2:
			return "", errors.New("offline")
		default:
			return "new", nil
		}
	})
	get(t, c, "sku", Loaded)
	clk.seconds.Store(10)
	if get(t, c, "sku", Stale) != "old" {
		t.Fatal("expected old value")
	}
	clk.seconds.Store(12)
	if get(t, c, "sku", Loaded) != "new" {
		t.Fatal("refresh did not replace fallback")
	}
	clk.seconds.Store(21)
	if get(t, c, "sku", Hit) != "new" {
		t.Fatal("refresh did not reset lifetime")
	}
}

func TestExpiredValueEvictedDuringRefreshIsNotResurrected(t *testing.T) {
	clk := &clock{}
	cfg := settings(clk)
	cfg.MaxEntries = 1
	gate := make(chan struct{})
	started := make(chan struct{})
	var firstKeyCalls atomic.Int64
	c := mustCache(t, cfg, func(ctx context.Context, key string) (string, error) {
		if key == "a" && firstKeyCalls.Add(1) == 2 {
			close(started)
			select {
			case <-gate:
				return "", errors.New("offline")
			case <-ctx.Done():
				return "", ctx.Err()
			}
		}
		return key, nil
	})
	get(t, c, "a", Loaded)
	clk.seconds.Store(11)
	outcome := make(chan error, 1)
	go func() { _, err := c.Get(context.Background(), "a"); outcome <- err }()
	take(t, started)
	get(t, c, "b", Loaded)
	close(gate)
	if err := take(t, outcome); err == nil {
		t.Fatal("returned evicted fallback")
	}
	get(t, c, "b", Hit)
}

func TestDeadlineAndAlreadyCancelledCaller(t *testing.T) {
	cfg := settings(&clock{})
	cfg.LoadTimeout = 25 * time.Millisecond
	var calls atomic.Int64
	c := mustCache(t, cfg, func(ctx context.Context, key string) (string, error) {
		calls.Add(1)
		<-ctx.Done()
		return "", ctx.Err()
	})
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Get(cancelled, "sku"); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if _, err := c.Get(context.Background(), "sku"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal(err)
	}
	if calls.Load() != 1 {
		t.Fatal(calls.Load())
	}
}
