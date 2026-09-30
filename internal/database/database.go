// Package database executes bounded, read-only requests against SQLite files.
package database

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/ncruces/go-sqlite3"
)

const (
	maxRows        = 1000
	maxText        = 4000
	maxResultBytes = 2_000_000
	timeoutMessage = "Query timed out. Add a filter or use an indexed column."
)

func Run(parent context.Context, request Request) (any, error) {
	started := time.Now()
	if request.Path == "" {
		return nil, errors.New("A database path is required.")
	}
	path, err := filepath.Abs(request.Path)
	if err != nil {
		return nil, err
	}
	seconds := request.Timeout
	if seconds == 0 {
		seconds = 15
	}
	ctx, cancel := context.WithTimeout(parent, time.Duration(max(1, min(seconds, 120))*float64(time.Second)))
	defer cancel()

	conn, err := sqlite3.OpenFlags(path, sqlite3.OPEN_READONLY)
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	conn.SetInterrupt(ctx)
	conn.Limit(sqlite3.LIMIT_LENGTH, 16_000_000)
	conn.Limit(sqlite3.LIMIT_SQL_LENGTH, 100_000)
	if err := conn.BusyTimeout(time.Second); err != nil {
		return nil, err
	}
	if err := conn.Exec("PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;"); err != nil {
		return nil, err
	}
	if err := conn.SetAuthorizer(authorize); err != nil {
		return nil, err
	}

	var result any
	switch request.Action {
	case "schema":
		result, err = readSchema(conn, path)
	case "browse":
		result, err = browse(conn, request)
	case "query":
		result, err = query(conn, request.SQL)
	default:
		err = errors.New("Unknown database action.")
	}
	if err != nil {
		if errors.Is(err, sqlite3.INTERRUPT) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return nil, errors.New(timeoutMessage)
		}
		return nil, err
	}

	switch value := result.(type) {
	case *Schema:
		value.ElapsedMs = time.Since(started).Milliseconds()
	case *Result:
		value.ElapsedMs = time.Since(started).Milliseconds()
	}
	return result, nil
}

func authorize(action sqlite3.AuthorizerActionCode, first, second, _, _ string) sqlite3.AuthorizerReturnCode {
	switch action {
	case sqlite3.AUTH_SELECT, sqlite3.AUTH_READ, sqlite3.AUTH_RECURSIVE:
		return sqlite3.AUTH_OK
	case sqlite3.AUTH_FUNCTION:
		if !strings.EqualFold(second, "load_extension") {
			return sqlite3.AUTH_OK
		}
	case sqlite3.AUTH_PRAGMA:
		switch first {
		case "table_xinfo", "index_list", "index_info", "foreign_key_list":
			return sqlite3.AUTH_OK
		}
	}
	return sqlite3.AUTH_DENY
}

func quote(name string) string {
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// prepare validates the entire SQL string before stepping the first statement.
func prepare(conn *sqlite3.Conn, sql string, args ...any) (*sqlite3.Stmt, error) {
	stmt, tail, err := conn.Prepare(sql)
	if err != nil {
		return nil, err
	}
	if stmt == nil {
		return nil, errors.New("Use a SELECT query that returns rows.")
	}

	if strings.TrimSpace(tail) != "" {
		extra, _, tailErr := conn.Prepare(tail)
		if extra != nil {
			extra.Close()
		}
		if tailErr != nil || extra != nil {
			stmt.Close()
			return nil, errors.New("Run one read-only SQL statement at a time.")
		}
	}
	if !stmt.ReadOnly() || stmt.ColumnCount() == 0 {
		stmt.Close()
		return nil, errors.New("Use a read-only SELECT query that returns rows.")
	}

	for i, arg := range args {
		switch value := arg.(type) {
		case string:
			err = stmt.BindText(i+1, value)
		case int:
			err = stmt.BindInt(i+1, value)
		case int64:
			err = stmt.BindInt64(i+1, value)
		default:
			err = fmt.Errorf("unsupported parameter type %T", arg)
		}
		if err != nil {
			stmt.Close()
			return nil, err
		}
	}
	return stmt, nil
}

func query(conn *sqlite3.Conn, sql string) (*Result, error) {
	stmt, err := prepare(conn, sql)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	columns := make([]string, stmt.ColumnCount())
	for i := range columns {
		columns[i] = stmt.ColumnName(i)
	}
	return readRows(stmt, columns, maxRows, false)
}

func readRows(stmt *sqlite3.Stmt, columns []string, limit int, browsing bool) (*Result, error) {
	result := &Result{Columns: columns, Rows: make([][]any, 0), Limit: limit}
	size := 0
	for stmt.Step() {
		if len(result.Rows) == limit {
			result.HasMore = true
			break
		}

		row := make([]any, len(columns))
		for i := range row {
			column := i
			if browsing {
				column = i * 2
				if stmt.ColumnType(column+1) != sqlite3.NULL {
					row[i] = BlobPreview{Type: "blob", Bytes: stmt.ColumnInt64(column + 1)}
					continue
				}
			}
			row[i] = cell(stmt, column)
		}

		encoded, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		size += len(encoded)
		if size > maxResultBytes {
			if len(result.Rows) == 0 {
				return nil, errors.New("One row exceeds the preview budget. Select fewer columns.")
			}
			result.HasMore = true
			break
		}
		result.Rows = append(result.Rows, row)
	}
	if err := stmt.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func cell(stmt *sqlite3.Stmt, column int) any {
	switch stmt.ColumnType(column) {
	case sqlite3.INTEGER:
		value := stmt.ColumnInt64(column)
		if value > 9007199254740991 || value < -9007199254740991 {
			return ExactNumber{Type: "integer", Value: strconv.FormatInt(value, 10)}
		}
		return value
	case sqlite3.FLOAT:
		value := stmt.ColumnFloat(column)
		if math.IsInf(value, 0) || math.IsNaN(value) {
			return ExactNumber{Type: "real", Value: strconv.FormatFloat(value, 'g', -1, 64)}
		}
		return value
	case sqlite3.TEXT:
		value := stmt.ColumnText(column)
		if utf8.RuneCountInString(value) > maxText {
			return TextPreview{Type: "text", Preview: string([]rune(value)[:maxText]), Truncated: true}
		}
		return value
	case sqlite3.BLOB:
		// The raw view avoids copying the SQLite buffer into another Go allocation.
		return BlobPreview{Type: "blob", Bytes: int64(len(stmt.ColumnRawBlob(column)))}
	default:
		return nil
	}
}
