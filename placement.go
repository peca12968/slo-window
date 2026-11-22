// Package placement calculates cache owners from a topology and an object key.
package placement

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"slices"
	"strings"
)

type Node struct {
	ID     string `json:"id"`
	Zone   string `json:"zone"`
	Weight int    `json:"weight"`
}

type Cluster struct {
	nodes  []Node
	copies int
}

func NewCluster(nodes []Node, copies int) (*Cluster, error) {
	zones, names := map[string]bool{}, map[string]bool{}
	for _, node := range nodes {
		if strings.TrimSpace(node.ID) == "" || strings.TrimSpace(node.Zone) == "" || node.Weight < 1 || names[node.ID] {
			return nil, fmt.Errorf("expected unique nonempty node IDs, a zone and positive ticket count: %+v", node)
		}
		zones[node.Zone], names[node.ID] = true, true
	}
	if copies < 1 || copies > len(zones) {
		return nil, fmt.Errorf("requested %d copies across %d available zones", copies, len(zones))
	}
	return &Cluster{slices.Clone(nodes), copies}, nil
}

// Tickets are identified by (key, node ID, index). Adding a node or increasing
// its weight preserves the scores of every existing ticket.
func score(key, id string, weight int) [sha256.Size]byte {
	data := binary.AppendUvarint(nil, uint64(len(key)))
	data = append(data, key...)
	data = binary.AppendUvarint(data, uint64(len(id)))
	data = append(data, id...)
	prefix := len(data)
	var best [sha256.Size]byte
	for i := range weight {
		data = binary.AppendUvarint(data[:prefix], uint64(i))
		digest := sha256.Sum256(data)
		if bytes.Compare(digest[:], best[:]) > 0 {
			best = digest
		}
	}
	return best
}

type ranked struct {
	id    string
	score [sha256.Size]byte
}

func compare(a, b ranked) int {
	if c := bytes.Compare(b.score[:], a.score[:]); c != 0 {
		return c
	}
	return strings.Compare(a.id, b.id)
}

// Owners returns primary first, then one replica from each remaining selected zone.
func (c *Cluster) Owners(key string) []string {
	winners := make(map[string]ranked)
	for _, n := range c.nodes {
		candidate := ranked{n.ID, score(key, n.ID, n.Weight)}
		if old, ok := winners[n.Zone]; !ok || compare(candidate, old) < 0 {
			winners[n.Zone] = candidate
		}
	}
	order := make([]ranked, 0, len(winners))
	for _, winner := range winners {
		order = append(order, winner)
	}
	slices.SortFunc(order, compare)
	owners := make([]string, c.copies)
	for i := range owners {
		owners[i] = order[i].id
	}
	return owners
}
