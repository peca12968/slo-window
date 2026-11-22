package cache

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
)

func TestStatsDuringSourceCongestion(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 1, 1)
		defer close(permits)
		ctx := context.Background()
		old := readAsync(c, ctx, "price")
		take(t, started)
		next := readAsync(c, ctx, "stock")
		synctest.Wait()
		for range 11 {
			reader, cancel := context.WithCancel(ctx)
			joined := readAsync(c, reader, "stock")
			synctest.Wait()
			cancel()
			if err := take(t, joined).err; !errors.Is(err, context.Canceled) {
				t.Fatal(err)
			}
		}
		if _, err := c.Get(ctx, "shipping"); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
		c.Invalidate("price")
		if err := take(t, old).err; !errors.Is(err, ErrInvalidated) {
			t.Fatal(err)
		}
		peak := c.Stats()
		wantPeak := Stats{
			Counters:    Counters{LoadsStarted: 1, SharedJoins: 11, BusyRejections: 1},
			ActiveLoads: 1, QueuedKeys: 1,
		}
		if peak != wantPeak {
			t.Fatalf("during congestion: got %+v, want %+v", peak, wantPeak)
		}
		permits <- struct{}{}
		take(t, started)
		permits <- struct{}{}
		wantLoaded(t, next, "stock")
		get(t, c, "stock", Hit)
		wantFinal := Stats{
			Counters: Counters{LoadsStarted: 2, Hits: 1, SharedJoins: 11, BusyRejections: 1, DiscardedLoads: 1},
			Entries:  1,
		}
		if final := c.Stats(); final != wantFinal {
			t.Fatalf("after recovery: got %+v, want %+v", final, wantFinal)
		}
	})
}

func TestStatsCountOneFallbackForSharedLoad(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		clock := &clock{}
		reply := make(chan error)
		c := mustCache(t, settings(clock), func(ctx context.Context, key string) (string, error) {
			return key, <-reply
		})
		ctx := context.Background()
		first := readAsync(c, ctx, "catalog")
		reply <- nil
		wantLoaded(t, first, "catalog")
		clock.seconds.Store(10)
		var readers [12]<-chan outcome
		for i := range readers {
			readers[i] = readAsync(c, ctx, "catalog")
		}
		synctest.Wait()
		down := errors.New("source down")
		reply <- down
		for _, reader := range readers {
			if got := take(t, reader); got.err != nil || got.result.Source != Stale {
				t.Fatalf("expected stale data, got %+v", got)
			}
		}
		clock.seconds.Store(15)
		expired := readAsync(c, ctx, "catalog")
		reply <- down
		if err := take(t, expired).err; !errors.Is(err, down) {
			t.Fatal(err)
		}
		want := Stats{Counters: Counters{SharedJoins: 11, LoadsStarted: 3, StaleFallbacks: 1}}
		if got := c.Stats(); got != want {
			t.Fatalf("got %+v, want %+v", got, want)
		}
	})
}
