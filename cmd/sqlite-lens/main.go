package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"

	"sqlite-lens/internal/database"
)

type response struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

func main() {
	var request database.Request
	decoder := json.NewDecoder(io.LimitReader(os.Stdin, 1_000_000))
	result := response{}
	err := decoder.Decode(&request)
	if err == nil {
		result.Data, err = database.Run(context.Background(), request)
	}
	if err != nil {
		result.Error = err.Error()
	} else {
		result.OK = true
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
