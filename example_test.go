package cache_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	cache "github.com/peca12968/coalesced-cache"
)

func ExampleNewWithWeightLimit() {
	sizes := map[string]int{"A": 3, "B": 3, "C": 4, "D": 7, "large": 12}
	assets, err := cache.NewWithWeightLimit(cache.Config{
		FreshFor: time.Minute, LoadTimeout: time.Second, MaxEntries: 3, MaxInFlight: 2,
	}, 0, 10, func(_ string, v string) uint64 { return uint64(len(v)) },
		func(_ context.Context, k string) (string, error) { return strings.Repeat("x", sizes[k]), nil })
	if err != nil {
		panic(err)
	}
	for _, key := range []string{"A", "B", "C", "A", "D", "large", "D"} {
		result, err := assets.Get(context.Background(), key)
		if err != nil {
			panic(err)
		}
		fmt.Println(key, result.Source, assets.Stats().Entries, assets.WeightStats().Resident)
	}
	// Output:
	// A loaded 1 3
	// B loaded 2 6
	// C loaded 3 10
	// A hit 3 10
	// D loaded 2 10
	// large loaded 2 10
	// D hit 2 10
}

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
