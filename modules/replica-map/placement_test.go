package placement

import (
	"fmt"
	"slices"
	"testing"
)

func TestExpansionPreservesOtherPrimariesAndSeparatesCopies(t *testing.T) {
	nodes := []Node{{"a", "north", 1}, {"b", "east", 1}, {"c", "south", 1}, {"d", "south", 1}}
	old, err := NewCluster(nodes, 3)
	if err != nil {
		t.Fatal(err)
	}
	newNodes := append(slices.Clone(nodes), Node{"new", "east", 2})
	next, err := NewCluster(newNodes, 3)
	if err != nil {
		t.Fatal(err)
	}
	slices.Reverse(newNodes)
	reordered, err := NewCluster(newNodes, 3)
	if err != nil {
		t.Fatal(err)
	}
	zones := make(map[string]string)
	for _, node := range newNodes {
		zones[node.ID] = node.Zone
	}
	moved := 0
	for i := range 4096 {
		key := fmt.Sprintf("asset-%04d", i)
		before, after := old.Owners(key), next.Owners(key)
		if before[0] != after[0] {
			moved++
			if after[0] != "new" {
				t.Fatalf("%s moved between old nodes", key)
			}
		}
		if !slices.Equal(reordered.Owners(key), after) {
			t.Fatalf("order-sensitive key %s", key)
		}
		if len(after) != 3 || zones[after[0]] == zones[after[1]] || zones[after[1]] == zones[after[2]] || zones[after[0]] == zones[after[2]] {
			t.Fatalf("lost zone separation: %v", after)
		}
	}
	if moved == 0 || moved == 4096 {
		t.Fatalf("unexpected movement count %d", moved)
	}
	t.Logf("%d of 4096 primaries moved to the new node; no old-to-old primary moves", moved)
}
