package placement

import (
	"math"
	"testing"
)

func TestGracefulDrainAndLossHaveDifferentOriginCost(t *testing.T) {
	old, _ := NewCluster([]Node{{"a", "east", 1}}, 1)
	next, _ := NewCluster([]Node{{"b", "west", 1}}, 1)
	objects := []Object{{"menu", 90}, {"cover", 110}}
	for _, failed := range []bool{false, true} {
		var unavailable []string
		if failed {
			unavailable = []string{"a"}
		}
		result, err := Compare(old, next, unavailable, objects)
		if err != nil {
			t.Fatal(err)
		}
		origin := int64(0)
		if failed {
			origin = 200
		}
		if result.CopyBytes != 200 || result.OriginBytes != origin || result.PrimaryChanges != 2 || result.PrimaryChangesWithoutCopy != 0 {
			t.Fatal(result)
		}
		for _, copy := range result.Transfers {
			if copy.To != "b" || (copy.From == nil) != failed || copy.From != nil && *copy.From != "a" {
				t.Fatal(copy)
			}
		}
	}
}

func TestInvalidScenariosProduceNoPlan(t *testing.T) {
	old, _ := NewCluster([]Node{{"old", "east", 1}}, 1)
	next, _ := NewCluster([]Node{{"new", "east", 1}}, 1)
	for _, objects := range [][]Object{
		{{"key", 1}, {"key", 2}}, {{"", -1}}, {{"one", math.MaxInt64}, {"two", 1}},
	} {
		if plan, err := Compare(old, next, nil, objects); err == nil || plan != nil {
			t.Fatalf("accepted %v", objects)
		}
	}
	for _, missing := range []string{"old", "new"} {
		if plan, err := Compare(old, old, []string{missing}, nil); err == nil || plan != nil {
			t.Fatal(missing)
		}
	}
	if _, err := NewCluster([]Node{{"a", "east", 1}, {"b", "east", 1}}, 2); err == nil {
		t.Fatal("two zones required")
	}
}
