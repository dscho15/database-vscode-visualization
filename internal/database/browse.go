package database

import (
	"errors"
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/ncruces/go-sqlite3"
)

func browse(conn *sqlite3.Conn, request Request) (*Result, error) {
	stmt, err := prepare(conn, "SELECT type FROM sqlite_schema WHERE name = ? AND type IN ('table', 'view')", request.Table)
	if err != nil {
		return nil, err
	}
	kind := ""
	if stmt.Step() {
		kind = stmt.ColumnText(0)
	}
	err = stmt.Err()
	stmt.Close()
	if err != nil {
		return nil, err
	}
	if kind == "" {
		return nil, errors.New("Table or view no longer exists. Refresh the database.")
	}

	columns, err := readColumns(conn, request.Table)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(columns))
	projection := make([]string, 0, len(columns)*2)
	keys := make([]Column, 0)
	for _, column := range columns {
		if column.Hidden == 1 {
			continue
		}
		names = append(names, column.Name)
		identifier := quote(column.Name)
		// SQLite computes BLOB lengths without loading the payload into the worker.
		projection = append(projection,
			fmt.Sprintf("CASE typeof(%[1]s) WHEN 'blob' THEN NULL WHEN 'text' THEN substr(%[1]s, 1, %d) ELSE %[1]s END", identifier, maxText+1),
			fmt.Sprintf("CASE WHEN typeof(%[1]s) = 'blob' THEN length(%[1]s) END", identifier),
		)
		if column.PK != 0 {
			keys = append(keys, column)
		}
	}

	parameters := make([]any, 0, 3)
	where := ""
	if request.FilterColumn != "" {
		if !slices.Contains(names, request.FilterColumn) {
			return nil, errors.New("Unknown filter column.")
		}
		where = " WHERE instr(CAST(" + quote(request.FilterColumn) + " AS TEXT), ?) > 0"
		parameters = append(parameters, request.FilterValue)
	}

	order := ""
	if request.Sort != "" {
		if !slices.Contains(names, request.Sort) {
			return nil, errors.New("Unknown sort column.")
		}
		order = " ORDER BY " + quote(request.Sort)
		if request.Descending {
			order += " DESC"
		}
	} else if len(keys) != 0 {
		sort.Slice(keys, func(i, j int) bool { return keys[i].PK < keys[j].PK })
		quoted := make([]string, len(keys))
		for i, key := range keys {
			quoted[i] = quote(key.Name)
		}
		order = " ORDER BY " + strings.Join(quoted, ", ")
	} else if kind == "table" {
		for _, rowid := range []string{"rowid", "_rowid_", "oid"} {
			if !slices.ContainsFunc(names, func(name string) bool { return strings.EqualFold(name, rowid) }) {
				order = " ORDER BY " + rowid
				break
			}
		}
	}

	limit := request.Limit
	if limit == 0 {
		limit = 100
	}
	limit = max(1, min(limit, maxRows))
	offset := max(int64(0), request.Offset)
	parameters = append(parameters, limit+1, offset)
	sql := "SELECT " + strings.Join(projection, ", ") + " FROM " + quote(request.Table) + where + order + " LIMIT ? OFFSET ?"
	stmt, err = prepare(conn, sql, parameters...)
	if err != nil {
		return nil, err
	}
	defer stmt.Close()

	result, err := readRows(stmt, names, limit, true)
	if err != nil {
		return nil, err
	}
	result.Offset = offset
	return result, nil
}
