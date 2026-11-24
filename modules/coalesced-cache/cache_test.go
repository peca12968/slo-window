package cache

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
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

func TestPriceChangeDiscardsLateRead(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var price, calls atomic.Int64
		price.Store(1299)
		allowReturn := make(chan struct{})
		release := sync.OnceFunc(func() { close(allowReturn) })
		defer release()
		c := mustCache(t, settings(&clock{}), func(context.Context, string) (string, error) {
			value := price.Load()
			if calls.Add(1) == 1 {
				<-allowReturn // The source already read the old price and ignores cancellation.
			}
			return strconv.FormatInt(value, 10), nil
		})
		waiters := make(chan error, 12)
		for range 12 {
			go func() { _, err := c.Get(context.Background(), "sku"); waiters <- err }()
		}
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("expected one unfinished read of the old price")
		}
		price.Store(1499)
		c.Invalidate("sku")
		for range 12 {
			if err := take(t, waiters); !errors.Is(err, ErrInvalidated) {
				t.Fatalf("old waiter: %v", err)
			}
		}
		if got := get(t, c, "sku", Loaded); got != "1499" {
			t.Fatal(got)
		}
		release()
		synctest.Wait() // The late loader completed its cache bookkeeping.
		if got := get(t, c, "sku", Hit); got != "1499" || calls.Load() != 2 {
			t.Fatalf("cached price %s, source reads %d", got, calls.Load())
		}
		t.Log("12 old waiters invalidated; origin reads: 2; final cache hit: 1499 cents")
	})
}

func TestLateCompletionCannotRemoveReplacementFlight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		oldGate, newGate := make(chan struct{}), make(chan struct{})
		finishOld := sync.OnceFunc(func() { close(oldGate) })
		finishNew := sync.OnceFunc(func() { close(newGate) })
		defer finishOld()
		defer finishNew()
		c := mustCache(t, settings(&clock{}), func(context.Context, string) (string, error) {
			if calls.Add(1) == 1 {
				<-oldGate
				return "", errors.New("old request failed")
			}
			<-newGate
			return "new", nil
		})
		oldErr := make(chan error, 1)
		go func() { _, err := c.Get(context.Background(), "sku"); oldErr <- err }()
		synctest.Wait()
		c.Invalidate("sku")
		if err := take(t, oldErr); !errors.Is(err, ErrInvalidated) {
			t.Fatal(err)
		}
		results := make(chan Result[string], 2)
		read := func() { v, _ := c.Get(context.Background(), "sku"); results <- v }
		go read()
		synctest.Wait()
		finishOld()
		synctest.Wait()
		go read()
		synctest.Wait()
		finishNew()
		for range 2 {
			if v := take(t, results); v != (Result[string]{"new", Loaded}) {
				t.Fatal(v)
			}
		}
		if calls.Load() != 2 {
			t.Fatal("replacement load was not shared", calls.Load())
		}
	})
}

func TestInvalidatedLoaderStillConsumesCapacityUntilItReturns(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := settings(&clock{})
		cfg.MaxInFlight = 1
		gate := make(chan struct{})
		release := sync.OnceFunc(func() { close(gate) })
		defer release()
		started := make(chan context.Context, 1)
		c := mustCache(t, cfg, func(ctx context.Context, key string) (string, error) {
			started <- ctx
			<-gate
			return key, nil
		})
		waiter := make(chan error, 1)
		go func() { _, err := c.Get(context.Background(), "sku"); waiter <- err }()
		loadCtx := take(t, started)
		c.Invalidate("sku")
		c.Invalidate("sku")
		if !errors.Is(loadCtx.Err(), context.Canceled) || !errors.Is(take(t, waiter), ErrInvalidated) {
			t.Fatal("load context or waiter was not cancelled")
		}
		for _, key := range []string{"sku", "other"} {
			if _, err := c.Get(context.Background(), key); !errors.Is(err, ErrBusy) {
				t.Fatalf("Get(%s): %v", key, err)
			}
		}
		release()
		synctest.Wait()
		get(t, c, "sku", Loaded)
	})
}

func TestInvalidationDropsGraceValueAndPreservesOtherKeys(t *testing.T) {
	clk := &clock{}
	var offline atomic.Bool
	failure := errors.New("offline")
	c := mustCache(t, settings(clk), func(_ context.Context, key string) (string, error) {
		if offline.Load() {
			return "", failure
		}
		return key, nil
	})
	get(t, c, "old", Loaded)
	clk.seconds.Store(8)
	get(t, c, "other", Loaded)
	clk.seconds.Store(11)
	offline.Store(true)
	get(t, c, "old", Stale)
	c.Invalidate("old")
	c.Invalidate("missing")
	if _, err := c.Get(context.Background(), "old"); !errors.Is(err, failure) {
		t.Fatal("invalidated price was still available for fallback", err)
	}
	get(t, c, "other", Hit)
}
