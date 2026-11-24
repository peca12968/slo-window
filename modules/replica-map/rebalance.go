package placement

import (
	"fmt"
	"math"
	"slices"
)

type Object struct {
	Key   string `json:"key"`
	Bytes int64  `json:"bytes"`
}

type Transfer struct {
	Key   string  `json:"key"`
	Bytes int64   `json:"bytes"`
	From  *string `json:"from"` // nil means fetch from the origin
	To    string  `json:"to"`
}

type Rebalance struct {
	Objects                   int        `json:"objects"`
	PrimaryChanges            int        `json:"primary_changes"`
	PrimaryChangesWithoutCopy int        `json:"primary_changes_without_copy"`
	CopyBytes                 int64      `json:"copy_bytes"`
	OriginBytes               int64      `json:"origin_bytes"`
	Transfers                 []Transfer `json:"transfers"`
}

// Compare assumes each old owner holds a complete copy. Retiring nodes can
// serve a graceful drain unless explicitly listed as unavailable.
func Compare(before, after *Cluster, unavailable []string, objects []Object) (*Rebalance, error) {
	if before == nil || after == nil || before.copies < 1 || after.copies < 1 {
		return nil, fmt.Errorf("both clusters must be initialized with NewCluster")
	}
	oldIDs := make(map[string]bool)
	for _, node := range before.nodes {
		oldIDs[node.ID] = true
	}
	offline := make(map[string]bool)
	for _, id := range unavailable {
		if !oldIDs[id] {
			return nil, fmt.Errorf("unavailable node %q not in original topology", id)
		}
		offline[id] = true
	}
	for _, n := range after.nodes {
		if offline[n.ID] {
			return nil, fmt.Errorf("unavailable node %q in target topology", n.ID)
		}
	}
	seen := make(map[string]bool)
	result := &Rebalance{Transfers: []Transfer{}}
	for _, obj := range objects {
		if obj.Key == "" || obj.Bytes < 0 || seen[obj.Key] {
			return nil, fmt.Errorf("invalid or repeated object %q", obj.Key)
		}
		seen[obj.Key] = true
		old, target := before.Owners(obj.Key), after.Owners(obj.Key)
		var source *string
		for i, id := range old {
			if !offline[id] {
				source = &old[i]
				break
			}
		}
		initialTransfers := len(result.Transfers)
		for _, id := range target {
			if slices.Contains(old, id) {
				continue
			}
			if obj.Bytes > math.MaxInt64-result.CopyBytes {
				return nil, fmt.Errorf("transfer bytes exceed int64 for %q", obj.Key)
			}
			result.CopyBytes += obj.Bytes
			if source == nil {
				result.OriginBytes += obj.Bytes
			}
			result.Transfers = append(result.Transfers, Transfer{obj.Key, obj.Bytes, source, id})
		}
		result.Objects++
		if old[0] != target[0] {
			result.PrimaryChanges++
			if len(result.Transfers) == initialTransfers {
				result.PrimaryChangesWithoutCopy++
			}
		}
	}
	return result, nil
}
