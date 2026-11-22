// Command replica-map plans cache transfers for a proposed topology change.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	placement "github.com/peca12968/replica-map"
)

type topology struct {
	Copies int              `json:"copies"`
	Nodes  []placement.Node `json:"nodes"`
}

type scenario struct {
	Before  topology `json:"before"`
	After   topology `json:"after"`
	Objects []struct {
		Key   string `json:"key"`
		Bytes *int64 `json:"bytes"`
	} `json:"objects"`
}

func plan(input io.Reader, unavailable []string, output io.Writer) error {
	var data scenario
	decoder := json.NewDecoder(input)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&data); err != nil {
		return err
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return errors.New("expected one JSON scenario")
	}
	if data.Objects == nil {
		return errors.New("expected an objects array")
	}
	before, err := placement.NewCluster(data.Before.Nodes, data.Before.Copies)
	if err != nil {
		return fmt.Errorf("before: %w", err)
	}
	after, err := placement.NewCluster(data.After.Nodes, data.After.Copies)
	if err != nil {
		return fmt.Errorf("after: %w", err)
	}
	objects := make([]placement.Object, 0, len(data.Objects))
	for _, obj := range data.Objects {
		if obj.Bytes == nil {
			return fmt.Errorf("missing byte count for %q", obj.Key)
		}
		objects = append(objects, placement.Object{Key: obj.Key, Bytes: *obj.Bytes})
	}
	report, err := placement.Compare(before, after, unavailable, objects)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(output)
	encoder.SetIndent("", "  ")
	return encoder.Encode(report)
}

func main() {
	var unavailable []string
	flag.Func("unavailable", "an old node that cannot serve transfers (repeatable)", func(id string) error {
		unavailable = append(unavailable, id)
		return nil
	})
	flag.Parse()
	if flag.NArg() > 1 {
		fmt.Fprintln(os.Stderr, "usage: replica-map [-unavailable id] [scenario.json]")
		os.Exit(2)
	}
	input := os.Stdin
	if flag.NArg() == 1 {
		file, err := os.Open(flag.Arg(0))
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(2)
		}
		input = file
	}
	if err := plan(input, unavailable, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
}
