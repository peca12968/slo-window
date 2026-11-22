package cache_test

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	cache "github.com/peca12968/coalesced-cache"
)

func ExampleCache_Invalidate() {
	var catalogPrice atomic.Int64
	catalogPrice.Store(1299)
	prices, err := cache.New(cache.Config{
		FreshFor: time.Minute, LoadTimeout: time.Second, MaxEntries: 8, MaxInFlight: 2,
	}, func(context.Context, string) (int64, error) {
		return catalogPrice.Load(), nil
	})
	if err != nil {
		panic(err)
	}
	quote := func() {
		got, err := prices.Get(context.Background(), "KIT-01")
		if err != nil {
			panic(err)
		}
		fmt.Println(got.Value, got.Source)
	}
	update := func(cents int64) error {
		if cents <= 0 {
			return errors.New("catalog rejected price")
		}
		catalogPrice.Store(cents)
		prices.Invalidate("KIT-01")
		return nil
	}

	quote()
	fmt.Println(update(-1))
	quote()
	if err := update(1499); err != nil {
		panic(err)
	}
	quote()
	quote()
	// Output:
	// 1299 loaded
	// catalog rejected price
	// 1299 hit
	// 1499 loaded
	// 1499 hit
}
