package cache

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestCooldownStartsAtFailureAndSharesRecoveryAtBoundary(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		clk := &clock{}
		cfg := settings(clk)
		cfg.StaleIfError = 20 * time.Second
		cfg.RetryAfterError = 3 * time.Second
		type answer struct {
			price string
			err   error
		}
		reply := make(chan answer)
		defer close(reply)
		var calls atomic.Int64
		c := mustCache(t, cfg, func(context.Context, string) (string, error) {
			calls.Add(1)
			a := <-reply
			return a.price, a.err
		})
		ctx := context.Background()
		first := readAsync(c, ctx, "sku")
		reply <- answer{price: "1299"}
		wantLoaded(t, first, "1299")
		clk.seconds.Store(10)
		failed := readAsync(c, ctx, "sku")
		synctest.Wait()
		clk.seconds.Store(12)
		reply <- answer{err: errors.New("source unavailable")}
		if got := take(t, failed); got.err != nil || got.result != (Result[string]{"1299", Stale}) {
			t.Fatal(got)
		}
		for _, second := range []int64{12, 13, 14} {
			clk.seconds.Store(second)
			for range 8 {
				if got := get(t, c, "sku", Stale); got != "1299" {
					t.Fatal(got)
				}
			}
		}
		if calls.Load() != 2 {
			t.Fatalf("24 subsequent reads made extra source calls: %d", calls.Load())
		}
		clk.seconds.Store(15)
		var readers [12]<-chan outcome
		for i := range readers {
			readers[i] = readAsync(c, ctx, "sku")
		}
		synctest.Wait()
		if calls.Load() != 3 {
			t.Fatalf("expected one recovery probe, total calls %d", calls.Load())
		}
		reply <- answer{price: "1499"}
		for _, r := range readers {
			wantLoaded(t, r, "1499")
		}
		if got := get(t, c, "sku", Hit); got != "1499" {
			t.Fatal(got)
		}
		want := Stats{Counters: Counters{LoadsStarted: 3, SharedJoins: 11,
			StaleFallbacks: 1, CooldownReads: 24, Hits: 1}, Entries: 1}
		if got := c.Stats(); got != want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})
}

func TestRepeatedFailuresNeverExtendTheOriginalStaleDeadline(t *testing.T) {
	clk := &clock{}
	cfg := settings(clk)
	cfg.RetryAfterError = 3 * time.Second
	down := errors.New("offline")
	var calls atomic.Int64
	c := mustCache(t, cfg, func(context.Context, string) (string, error) {
		if calls.Add(1) == 1 {
			return "old", nil
		}
		return "", down
	})
	get(t, c, "sku", Loaded)
	for _, second := range []int64{10, 11, 12, 13, 14} {
		clk.seconds.Store(second)
		get(t, c, "sku", Stale)
	}
	// Failure at 13 normally delays a retry until 16. The value expires at 15.
	clk.seconds.Store(15)
	for range 2 {
		if _, err := c.Get(context.Background(), "sku"); !errors.Is(err, down) {
			t.Fatal(err)
		}
	}
	want := Stats{Counters: Counters{LoadsStarted: 5, StaleFallbacks: 2, CooldownReads: 3}}
	if got := c.Stats(); got != want || calls.Load() != 5 {
		t.Fatalf("stats %+v, source calls %d", got, calls.Load())
	}
}

func TestCooldownWhileSourceIsFullAndAfterInvalidation(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		clk := &clock{}
		cfg := settings(clk)
		cfg.RetryAfterError = time.Minute
		cfg.MaxInFlight = 1
		release := make(chan struct{})
		defer close(release)
		var skuCalls atomic.Int64
		c := mustCache(t, cfg, func(_ context.Context, key string) (string, error) {
			if key == "slow" {
				<-release
				return key, nil
			}
			switch skuCalls.Add(1) {
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
		get(t, c, "sku", Stale)
		ctx := context.Background()
		slow := readAsync(c, ctx, "slow")
		synctest.Wait()
		get(t, c, "sku", Stale)
		cancelled, cancel := context.WithCancel(ctx)
		cancel()
		if _, err := c.Get(cancelled, "sku"); !errors.Is(err, context.Canceled) {
			t.Fatal(err)
		}
		c.Invalidate("sku")
		if _, err := c.Get(ctx, "sku"); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
		release <- struct{}{}
		wantLoaded(t, slow, "slow")
		if got := get(t, c, "sku", Loaded); got != "new" {
			t.Fatal(got)
		}
		if stats := c.Stats(); stats.CooldownReads != 1 || stats.BusyRejections != 1 {
			t.Fatal(stats)
		}
	})
}

func TestNegativeCooldownRejected(t *testing.T) {
	cfg := settings(&clock{})
	cfg.RetryAfterError = -time.Second
	if _, err := New(cfg, func(context.Context, string) (int, error) { return 1, nil }); err == nil {
		t.Fatal("negative retry delay accepted")
	}
}

func TestCooldownFollowsEntryRecencyAndEviction(t *testing.T) {
	clk := &clock{}
	cfg := settings(clk)
	cfg.RetryAfterError = time.Minute
	var priceCalls atomic.Int64
	c := mustCache(t, cfg, func(_ context.Context, key string) (string, error) {
		if key == "price" && priceCalls.Add(1) == 2 {
			return "", errors.New("offline")
		}
		return key, nil
	})
	get(t, c, "price", Loaded)
	get(t, c, "stock", Loaded)
	clk.seconds.Store(10)
	get(t, c, "price", Stale)
	get(t, c, "stock", Loaded) // This key can refresh despite the price failure.
	get(t, c, "price", Stale)  // Price becomes most recently used.
	get(t, c, "shipping", Loaded)
	get(t, c, "price", Stale)
	get(t, c, "stock", Loaded)
	get(t, c, "shipping", Loaded) // Price and its retry state are now evicted.
	get(t, c, "price", Loaded)
	if priceCalls.Load() != 3 {
		t.Fatal(priceCalls.Load())
	}
}
