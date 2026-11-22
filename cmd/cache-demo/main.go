// Run a reproducible burst against a synthetic loopback HTTP catalog.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"time"

	cache "github.com/peca12968/coalesced-cache"
)

type price struct {
	Cents int `json:"cents"`
}

func run() error {
	var down atomic.Bool
	var calls, seconds atomic.Int64
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if down.Load() {
			http.Error(w, "catalog unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(price{Cents: 1299})
	}))
	defer origin.Close()

	c, err := cache.New(cache.Config{FreshFor: 10 * time.Second, StaleIfError: 5 * time.Second,
		RetryAfterError: 30 * time.Second, LoadTimeout: 3 * time.Second, MaxEntries: 32, MaxInFlight: 4,
		Now: func() time.Time { return time.Unix(seconds.Load(), 0) },
	}, func(ctx context.Context, sku string) (price, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, origin.URL+"/prices/"+sku, nil)
		if err != nil {
			return price{}, err
		}
		resp, err := origin.Client().Do(req)
		if err != nil {
			return price{}, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return price{}, fmt.Errorf("catalog returned %d", resp.StatusCode)
		}
		var result price
		err = json.NewDecoder(resp.Body).Decode(&result)
		return result, err
	})
	if err != nil {
		return err
	}
	ctx := context.Background()
	var group sync.WaitGroup
	start := make(chan struct{})
	outcomes := make(chan error, 12)
	for range 12 {
		group.Go(func() {
			<-start
			got, err := c.Get(ctx, "KIT-01")
			if err == nil && got.Value.Cents != 1299 {
				err = fmt.Errorf("unexpected price")
			}
			outcomes <- err
		})
	}
	close(start)
	group.Wait()
	close(outcomes)
	for err := range outcomes {
		if err != nil {
			return err
		}
	}
	burstCalls := calls.Load()
	if burstCalls != 1 {
		return fmt.Errorf("expected one catalog call, got %d", burstCalls)
	}

	down.Store(true)
	seconds.Store(10)
	fallback, err := c.Get(ctx, "KIT-01")
	if err != nil {
		return err
	}
	if fallback.Source != cache.Stale {
		return fmt.Errorf("expected stale price")
	}
	beforeCooldown := calls.Load()
	for i := range 24 {
		seconds.Store(11 + int64(i/6))
		got, err := c.Get(ctx, "KIT-01")
		if err != nil || got.Source != cache.Stale || got.Value != fallback.Value {
			return fmt.Errorf("unexpected cooldown result: %+v, %v", got, err)
		}
	}
	cooldownCalls := calls.Load() - beforeCooldown
	if cooldownCalls != 0 {
		return fmt.Errorf("cooldown readers made %d source calls", cooldownCalls)
	}
	seconds.Store(15)
	_, finalErr := c.Get(ctx, "KIT-01")
	if finalErr == nil {
		return fmt.Errorf("expected upstream failure after grace period")
	}
	stats := c.Stats()
	if stats.LoadsStarted != uint64(calls.Load()) || stats.StaleFallbacks != 1 ||
		stats.Hits+stats.SharedJoins != 11 || stats.CooldownReads != 24 {
		return fmt.Errorf("unexpected cache statistics: %+v", stats)
	}
	return json.NewEncoder(os.Stdout).Encode(map[string]any{
		"concurrent_reads": 12, "origin_calls_for_burst": burstCalls,
		"at_second_10": fallback.Source, "price_cents": fallback.Value.Cents,
		"at_second_15": finalErr.Error(), "total_origin_calls": calls.Load(),
		"cooldown_reads": stats.CooldownReads, "origin_calls_for_cooldown_reads": cooldownCalls,
		"cache_stats": stats,
	})
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
