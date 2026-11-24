package cache

import (
	"context"
	"errors"
	"math"
	"strings"
	"testing"
	"testing/synctest"
)

func bytesOf(_ string, value string) uint64 { return uint64(len(value)) }

func TestWeightEvictsInLRUOrderIncludingZeroCostEntries(t *testing.T) {
	cfg := settings(&clock{})
	cfg.MaxEntries = 3
	sizes := map[string]int{"A": 3, "B": 3, "C": 4, "D": 7}
	c, err := NewWithWeightLimit(cfg, 0, 10, bytesOf, func(_ context.Context, key string) (string, error) { return strings.Repeat(key, sizes[key]), nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"A", "B", "C"} {
		get(t, c, key, Loaded)
	}
	get(t, c, "A", Hit)
	get(t, c, "D", Loaded)
	get(t, c, "A", Hit)
	get(t, c, "D", Hit)
	if s := c.WeightStats(); s != (WeightStats{Limit: 10, Resident: 10}) || c.Stats().Entries != 2 {
		t.Fatal(s, c.Stats())
	}
	get(t, c, "empty", Loaded)
	get(t, c, "empty2", Loaded)
	if c.Stats().Entries != 3 || c.WeightStats().Resident != 7 {
		t.Fatal(c.WeightStats(), c.Stats())
	}
	c.Invalidate("D")
	if c.WeightStats().Resident != 0 || c.Stats().Entries != 2 {
		t.Fatal(c.WeightStats(), c.Stats())
	}
}

func TestWeightOversizedRefreshSharesResultAndReleasesOldWeight(t *testing.T) {
	timer := &clock{}
	cfg := settings(timer)
	size := 2
	gate := make(chan struct{})
	fail := false
	c, err := NewWithWeightLimit(cfg, 1, 10, bytesOf, func(_ context.Context, key string) (string, error) {
		if fail {
			return "", errors.New("source unavailable")
		}
		if size > 10 {
			<-gate
		}
		return strings.Repeat("x", size), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	get(t, c, "price", Loaded)
	timer.seconds.Store(5)
	get(t, c, "other", Loaded)
	timer.seconds.Store(10)
	size = 12
	joined := make(chan struct{}, 12)
	results := make([]<-chan outcome, 12)
	for i := range results {
		results[i] = readAsync(c, observed{context.Background(), joined}, "price")
	}
	for range results {
		take(t, joined)
	}
	close(gate)
	for _, ch := range results {
		got := take(t, ch)
		if got.err != nil || len(got.result.Value) != 12 || got.result.Source != Loaded {
			t.Fatal(got)
		}
	}
	if got := c.WeightStats(); got != (WeightStats{Limit: 10, Resident: 2, OversizedLoads: 1}) {
		t.Fatal(got)
	}
	if s := c.Stats(); s.SharedJoins != 11 || s.LoadsStarted != 3 || s.Entries != 1 {
		t.Fatal(s)
	}
	fail = true
	get(t, c, "other", Hit)
	if _, err := c.Get(context.Background(), "price"); err == nil {
		t.Fatal("old oversized replacement still resident")
	}
	timer.seconds.Store(16)
	get(t, c, "other", Stale)
	if c.WeightStats().Resident != 2 {
		t.Fatal(c.WeightStats())
	}
	timer.seconds.Store(20)
	if _, err := c.Get(context.Background(), "other"); err == nil || c.WeightStats().Resident != 0 {
		t.Fatal(err, c.WeightStats())
	}
}

func TestWeightInvalidationWhileWeighingAndOverflow(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := settings(&clock{})
		started, release := make(chan struct{}), make(chan struct{})
		done := false
		defer func() {
			if !done {
				close(release)
			}
		}()
		c, err := NewWithWeightLimit(cfg, 0, math.MaxUint64, func(key, value string) uint64 {
			if key == "pending" {
				close(started)
				<-release
			}
			return math.MaxUint64
		}, func(_ context.Context, key string) (string, error) { return key, nil })
		if err != nil {
			t.Fatal(err)
		}
		pending := readAsync(c, context.Background(), "pending")
		<-started
		get(t, c, "one", Loaded)
		c.Invalidate("pending")
		if got := take(t, pending); !errors.Is(got.err, ErrInvalidated) {
			t.Fatal(got)
		}
		close(release)
		done = true
		synctest.Wait()
		get(t, c, "two", Loaded)
		if c.Stats().Entries != 1 || c.WeightStats().Resident != math.MaxUint64 || c.Stats().DiscardedLoads != 1 {
			t.Fatal(c.Stats(), c.WeightStats())
		}
	})
}
