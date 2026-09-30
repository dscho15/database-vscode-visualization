// This test-only tool creates a disposable database for Node and browser tests.
package main

import (
	"fmt"
	"os"

	"github.com/ncruces/go-sqlite3"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: fixture DATABASE")
		os.Exit(1)
	}
	if err := create(os.Args[1]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func create(path string) error {
	conn, err := sqlite3.Open(path)
	if err != nil {
		return err
	}
	defer conn.Close()
	return conn.Exec(`
		CREATE TABLE t(x);
		CREATE TABLE samples(id INTEGER PRIMARY KEY, label TEXT, value REAL, payload BLOB);
		CREATE TABLE related(id INTEGER PRIMARY KEY, sample INTEGER REFERENCES samples(id));
		WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<249)
		INSERT INTO samples SELECT x,
			CASE WHEN x=0 THEN '<script>alert(1)</script>' ELSE 'item ' || x END,
			x*1.5, zeroblob(100) FROM n;
	`)
}
