package database

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ncruces/go-sqlite3"
)

func fixture(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "test #?.sqlite3")
	conn, err := sqlite3.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	err = conn.Exec(`
		CREATE TABLE parent (id INTEGER PRIMARY KEY, label TEXT);
		CREATE TABLE "odd ' table" (
			id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id),
			text TEXT, value REAL, payload BLOB, big INTEGER
		);
		CREATE INDEX value_idx ON "odd ' table"(value);
		INSERT INTO parent VALUES (1, 'one');
		CREATE VIEW labels AS SELECT label FROM parent;
		CREATE TABLE compound (a TEXT, b INTEGER, PRIMARY KEY(a, b)) WITHOUT ROWID;
		INSERT INTO compound VALUES ('a', 1), ('a', 2);
		CREATE TABLE generated (x INTEGER, y INTEGER GENERATED ALWAYS AS (x * 2));
		INSERT INTO generated(x) VALUES (4);
		WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<11)
		INSERT INTO "odd ' table" SELECT i, 1,
			CASE WHEN i=0 THEN replace(hex(zeroblob(2500)), '0', '界') ELSE 'row '||i END,
			i/2.0, zeroblob(10000), 1152921504606846976 FROM n;
	`)
	closeErr := conn.Close()
	if err != nil {
		t.Fatal(err)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}

	original, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		current, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(original, current) {
			t.Errorf("database changed: %v", err)
		}
	})
	return path
}

func run(t *testing.T, path string, request Request) any {
	t.Helper()
	request.Path = path
	result, err := Run(t.Context(), request)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSchemaAndGeneratedColumns(t *testing.T) {
	path := fixture(t)
	schema := run(t, path, Request{Action: "schema"}).(*Schema)
	var found bool
	for _, table := range schema.Tables {
		if table.Name == "odd ' table" {
			found = true
			if table.ForeignKeys[0].Table != "parent" || *table.Indexes[0].Columns[0] != "value" {
				t.Fatalf("unexpected schema: %+v", table)
			}
		}
	}
	if !found {
		t.Fatal("quoted table missing")
	}
	result := run(t, path, Request{Action: "browse", Table: "generated"}).(*Result)
	if !reflect.DeepEqual(result.Rows, [][]any{{int64(4), int64(8)}}) {
		t.Fatal(result.Rows)
	}
}

func TestBrowsePaginationAndPreviews(t *testing.T) {
	path := fixture(t)
	request := Request{Action: "browse", Table: "odd ' table", Limit: 5}
	result := run(t, path, request).(*Result)
	if len(result.Rows) != 5 || !result.HasMore {
		t.Fatalf("unexpected page: %+v", result)
	}
	row := result.Rows[0]
	if row[4] != (BlobPreview{Type: "blob", Bytes: 10000}) {
		t.Fatal(row[4])
	}
	text := row[2].(TextPreview)
	if !text.Truncated || utf8.RuneCountInString(text.Preview) != maxText {
		t.Fatal("Unicode preview was not truncated at the character boundary")
	}
	if row[5].(ExactNumber).Value != "1152921504606846976" {
		t.Fatal("integer lost precision")
	}
	request.Offset = 10
	result = run(t, path, request).(*Result)
	if len(result.Rows) != 2 || result.Rows[0][0] != int64(10) || result.HasMore {
		t.Fatal("incorrect final page")
	}
}

func TestFilterSortAndQuotedIdentifiers(t *testing.T) {
	path := fixture(t)
	request := Request{Action: "browse", Table: "odd ' table", FilterColumn: "text", FilterValue: "row 1", Sort: "id", Descending: true}
	result := run(t, path, request).(*Result)
	ids := []any{result.Rows[0][0], result.Rows[1][0], result.Rows[2][0]}
	if !reflect.DeepEqual(ids, []any{int64(11), int64(10), int64(1)}) {
		t.Fatal(ids)
	}
	request.FilterValue = "' OR 1=1 --"
	result = run(t, path, request).(*Result)
	if len(result.Rows) != 0 {
		t.Fatal("filter was not bound as a parameter")
	}
	encoded, err := json.Marshal(result)
	if err != nil || !bytes.Contains(encoded, []byte(`"rows":[]`)) {
		t.Fatal("empty results must use a JSON array")
	}
	request.Path = path
	request.Sort = "id; DROP TABLE parent"
	if _, err := Run(t.Context(), request); err == nil {
		t.Fatal("invalid sort column accepted")
	}
}

func TestViewsAndWithoutRowID(t *testing.T) {
	path := fixture(t)
	for table, expected := range map[string][][]any{
		"labels": {{"one"}}, "compound": {{"a", int64(1)}, {"a", int64(2)}},
	} {
		result := run(t, path, Request{Action: "browse", Table: table}).(*Result)
		if !reflect.DeepEqual(result.Rows, expected) {
			t.Fatalf("%s: %v", table, result.Rows)
		}
	}
}

func TestQueryCTEAndDuplicateColumns(t *testing.T) {
	path := fixture(t)
	result := run(t, path, Request{Action: "query", SQL: "WITH x AS (SELECT 2 AS n) SELECT n, n, NULL FROM x; -- trailing comment"}).(*Result)
	if !reflect.DeepEqual(result.Columns, []string{"n", "n", "NULL"}) ||
		!reflect.DeepEqual(result.Rows, [][]any{{int64(2), int64(2), nil}}) {
		t.Fatal(result)
	}
}

func TestRejectWritesAndMultipleStatements(t *testing.T) {
	path := fixture(t)
	queries := []string{
		"DELETE FROM parent", "DROP TABLE parent", "CREATE TABLE nope(x)",
		"WITH x AS (SELECT 1) DELETE FROM parent RETURNING *",
		"PRAGMA query_only=OFF", "PRAGMA user_version=7", "PRAGMA journal_mode=WAL",
		"ATTACH DATABASE ':memory:' AS extra", "VACUUM", "BEGIN",
		"SELECT load_extension('/tmp/nope')", "SELECT 1; DELETE FROM parent",
		"SELECT 1; SELECT 2", "SELECT 1; /* comment */ ; SELECT 2", "",
	}
	for _, sql := range queries {
		t.Run(sql, func(t *testing.T) {
			if _, err := Run(t.Context(), Request{Path: path, Action: "query", SQL: sql}); err == nil {
				t.Fatal("unsafe or invalid SQL accepted")
			}
		})
	}
}

func TestQueryLimitsAndTimeout(t *testing.T) {
	path := fixture(t)
	result := run(t, path, Request{Action: "query", SQL: `WITH RECURSIVE n(x) AS
		(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT x FROM n`}).(*Result)
	if len(result.Rows) != maxRows || !result.HasMore {
		t.Fatal("row cap not applied")
	}
	result = run(t, path, Request{Action: "query", SQL: `WITH RECURSIVE n(x) AS
		(VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<2000) SELECT replace(hex(zeroblob(2000)), '0', '界') FROM n`}).(*Result)
	if len(result.Rows) == 0 || len(result.Rows) >= maxRows || !result.HasMore {
		t.Fatal("result byte budget not applied")
	}
	_, err := Run(t.Context(), Request{Path: path, Action: "query", Timeout: 1,
		SQL: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n"})
	if err == nil || err.Error() != timeoutMessage {
		t.Fatalf("expected timeout: %v", err)
	}
	if _, err := Run(t.Context(), Request{Path: path, Action: "query", SQL: "SELECT zeroblob(20000000)"}); err == nil {
		t.Fatal("SQLite value limit not applied")
	}
}

func TestBrowseLargeBlob(t *testing.T) {
	path := filepath.Join(t.TempDir(), "large.sqlite3")
	conn, err := sqlite3.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.Exec("CREATE TABLE big(payload BLOB); INSERT INTO big VALUES(zeroblob(20000000))"); err != nil {
		t.Fatal(err)
	}
	result := run(t, path, Request{Action: "browse", Table: "big"}).(*Result)
	if !reflect.DeepEqual(result.Rows, [][]any{{BlobPreview{Type: "blob", Bytes: 20000000}}}) {
		t.Fatal(result.Rows)
	}
}

func TestWALReadsCommittedChanges(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wal.sqlite3")
	writer, err := sqlite3.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if err := writer.Exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1)"); err != nil {
		t.Fatal(err)
	}
	for i := int64(1); i <= 2; i++ {
		result := run(t, path, Request{Action: "query", SQL: "SELECT count(*) FROM t"}).(*Result)
		if result.Rows[0][0] != i {
			t.Fatal("committed WAL state not visible")
		}
		if err := writer.Exec("INSERT INTO t VALUES(2)"); err != nil {
			t.Fatal(err)
		}
	}
}

func TestMissingInvalidAndEmptyDatabases(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing.sqlite3")
	if _, err := Run(context.Background(), Request{Path: path, Action: "schema"}); err == nil {
		t.Fatal("missing file opened")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("missing database created")
	}
	if err := os.WriteFile(path, []byte("not a database"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Run(t.Context(), Request{Path: path, Action: "schema"}); err == nil {
		t.Fatal("invalid database opened")
	}
	if err := os.WriteFile(path, nil, 0600); err != nil {
		t.Fatal(err)
	}
	schema := run(t, path, Request{Action: "schema"}).(*Schema)
	encoded, err := json.Marshal(schema)
	if err != nil || !strings.Contains(string(encoded), `"tables":[]`) {
		t.Fatal("empty schema must use a JSON array")
	}
}
