package cache

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"
)

type outcome struct {
	result Result[string]
	err    error
}

func readAsync(c *Cache[string], ctx context.Context, key string) <-chan outcome {
	done := make(chan outcome, 1)
	go func() {
		v, err := c.Get(ctx, key)
		done <- outcome{v, err}
	}()
	return done
}

// Each source call reports its key and stays active until a permit is sent.
// Closing permits also lets unfinished calls exit on test failure.
func queuedCache(t *testing.T, slots, waiting int) (*Cache[string], <-chan string, chan struct{}) {
	t.Helper()
	cfg := settings(&clock{})
	cfg.MaxInFlight = slots
	started := make(chan string, 32)
	permits := make(chan struct{})
	c, err := NewWithQueue(cfg, waiting, func(_ context.Context, key string) (string, error) {
		started <- key
		<-permits
		return key, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return c, started, permits
}

func wantLoaded(t *testing.T, done <-chan outcome, key string) {
	t.Helper()
	if got := take(t, done); got.err != nil || got.result != (Result[string]{key, Loaded}) {
		t.Fatalf("Get(%q) = %+v", key, got)
	}
}

func TestQueueBurstSharesFIFOAdmission(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 1, 2)
		defer close(permits)
		ctx := context.Background()
		a := readAsync(c, ctx, "A")
		if key := take(t, started); key != "A" {
			t.Fatal(key)
		}
		b := make([]<-chan outcome, 12)
		b[0] = readAsync(c, ctx, "B")
		synctest.Wait()
		last := readAsync(c, ctx, "C")
		synctest.Wait()
		for i := 1; i < len(b); i++ {
			b[i] = readAsync(c, ctx, "B")
		}
		synctest.Wait()
		if _, err := c.Get(ctx, "D"); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
		if len(started) != 0 {
			t.Fatal("source exceeded concurrent load limit")
		}
		permits <- struct{}{}
		wantLoaded(t, a, "A")
		if key := take(t, started); key != "B" {
			t.Fatal(key)
		}
		permits <- struct{}{}
		for _, done := range b {
			wantLoaded(t, done, "B")
		}
		if key := take(t, started); key != "C" {
			t.Fatal(key)
		}
		permits <- struct{}{}
		wantLoaded(t, last, "C")
		synctest.Wait()
		if len(started) != 0 {
			t.Fatal("unexpected source load")
		}
		t.Log("1 active slot, 2 waiting keys, 12 readers for B; origin order: A B C; D rejected")
	})
}

func TestLastQueuedReaderLeavingReclaimsSlot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 1, 1)
		defer close(permits)
		ctx := context.Background()
		a := readAsync(c, ctx, "active")
		take(t, started)
		first, cancelFirst := context.WithCancel(ctx)
		second, cancelSecond := context.WithCancel(ctx)
		defer cancelFirst()
		defer cancelSecond()
		b := readAsync(c, first, "shared")
		b2 := readAsync(c, second, "shared")
		synctest.Wait()
		cancelFirst()
		if !errors.Is(take(t, b).err, context.Canceled) {
			t.Fatal("first waiter stayed")
		}
		if _, err := c.Get(ctx, "replacement"); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
		cancelSecond()
		if !errors.Is(take(t, b2).err, context.Canceled) {
			t.Fatal("second waiter stayed")
		}
		replacement := readAsync(c, ctx, "replacement")
		synctest.Wait()
		permits <- struct{}{}
		wantLoaded(t, a, "active")
		if key := take(t, started); key != "replacement" {
			t.Fatal(key)
		}
		permits <- struct{}{}
		wantLoaded(t, replacement, "replacement")
	})
}

func TestInvalidatingWaitingAndRunningKeysKeepsCapacityBound(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 1, 1)
		defer close(permits)
		ctx := context.Background()
		old := readAsync(c, ctx, "price")
		take(t, started)
		first := readAsync(c, ctx, "discard")
		second := readAsync(c, ctx, "discard")
		synctest.Wait()
		c.Invalidate("discard")
		for _, done := range []<-chan outcome{first, second} {
			if !errors.Is(take(t, done).err, ErrInvalidated) {
				t.Fatal("queued reader not released")
			}
		}
		c.Invalidate("price")
		if !errors.Is(take(t, old).err, ErrInvalidated) {
			t.Fatal("running reader not released")
		}
		fresh := readAsync(c, ctx, "price")
		synctest.Wait()
		if len(started) != 0 {
			t.Fatal("replacement started before invalidated source returned")
		}
		permits <- struct{}{}
		if key := take(t, started); key != "price" {
			t.Fatal(key)
		}
		permits <- struct{}{}
		wantLoaded(t, fresh, "price")
		get(t, c, "price", Hit)
	})
}

func TestQueuedLoadGetsItsOwnDeadlineAtDispatch(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 1, 1)
		defer close(permits)
		ctx := context.Background()
		a := readAsync(c, ctx, "A")
		take(t, started)
		b := readAsync(c, ctx, "B")
		synctest.Wait()
		time.Sleep(4 * time.Second)
		permits <- struct{}{}
		wantLoaded(t, a, "A")
		if key := take(t, started); key != "B" {
			t.Fatal(key)
		}
		time.Sleep(4 * time.Second)
		permits <- struct{}{}
		wantLoaded(t, b, "B") // Total wait was 8s; the configured source timeout is 5s.
	})
}

func TestQueuedReaderDeadlineLeavesPeerAndHotHitAvailable(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		c, started, permits := queuedCache(t, 2, 1)
		defer close(permits)
		ctx := context.Background()
		hot := readAsync(c, ctx, "cached")
		take(t, started)
		permits <- struct{}{}
		wantLoaded(t, hot, "cached")
		a := readAsync(c, ctx, "A")
		take(t, started)
		b := readAsync(c, ctx, "B")
		take(t, started)
		short, cancel := context.WithTimeout(ctx, time.Second)
		defer cancel()
		waiting := readAsync(c, short, "C")
		peer := readAsync(c, ctx, "C")
		synctest.Wait()
		get(t, c, "cached", Hit)
		if err := take(t, waiting).err; !errors.Is(err, context.DeadlineExceeded) {
			t.Fatal(err)
		}
		if _, err := c.Get(ctx, "overflow"); !errors.Is(err, ErrBusy) {
			t.Fatal(err)
		}
		permits <- struct{}{}
		if key := take(t, started); key != "C" {
			t.Fatal(key)
		}
		permits <- struct{}{}
		permits <- struct{}{}
		wantLoaded(t, a, "A")
		wantLoaded(t, b, "B")
		wantLoaded(t, peer, "C")
	})
}

func TestNegativeWaitingCapacityIsRejected(t *testing.T) {
	if _, err := NewWithQueue(settings(&clock{}), -1, func(context.Context, string) (int, error) {
		return 0, nil
	}); err == nil {
		t.Fatal("accepted a negative waiting capacity")
	}
}
