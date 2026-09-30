package database

import (
	"os"
	"path/filepath"

	"github.com/ncruces/go-sqlite3"
)

func scan(conn *sqlite3.Conn, sql string, row func(*sqlite3.Stmt) error) error {
	stmt, err := prepare(conn, sql)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for stmt.Step() {
		if err := row(stmt); err != nil {
			return err
		}
	}
	return stmt.Err()
}

func nullableText(stmt *sqlite3.Stmt, column int) *string {
	if stmt.ColumnType(column) == sqlite3.NULL {
		return nil
	}
	value := stmt.ColumnText(column)
	return &value
}

func readColumns(conn *sqlite3.Conn, name string) ([]Column, error) {
	columns := make([]Column, 0)
	err := scan(conn, "PRAGMA table_xinfo("+quote(name)+")", func(stmt *sqlite3.Stmt) error {
		columns = append(columns, Column{
			Name: stmt.ColumnText(1), Type: stmt.ColumnText(2), NotNull: stmt.ColumnBool(3),
			Default: nullableText(stmt, 4), PK: stmt.ColumnInt(5), Hidden: stmt.ColumnInt(6),
		})
		return nil
	})
	return columns, err
}

func readSchema(conn *sqlite3.Conn, path string) (*Schema, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	schema := &Schema{Name: filepath.Base(path), Path: path, Size: info.Size(), Tables: make([]Table, 0)}
	err = scan(conn, "SELECT sqlite_version()", func(stmt *sqlite3.Stmt) error {
		schema.SQLiteVersion = stmt.ColumnText(0)
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = scan(conn, `SELECT name, type, sql FROM sqlite_schema
		WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`, func(stmt *sqlite3.Stmt) error {
		schema.Tables = append(schema.Tables, Table{
			Name: stmt.ColumnText(0), Type: stmt.ColumnText(1), SQL: stmt.ColumnText(2),
			Indexes: make([]Index, 0), ForeignKeys: make([]ForeignKey, 0),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}

	for i := range schema.Tables {
		table := &schema.Tables[i]
		table.Columns, err = readColumns(conn, table.Name)
		if err != nil {
			return nil, err
		}
		err = scan(conn, "PRAGMA index_list("+quote(table.Name)+")", func(stmt *sqlite3.Stmt) error {
			table.Indexes = append(table.Indexes, Index{
				Name: stmt.ColumnText(1), Unique: stmt.ColumnBool(2), Origin: stmt.ColumnText(3),
				Partial: stmt.ColumnBool(4), Columns: make([]*string, 0),
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
		for j := range table.Indexes {
			index := &table.Indexes[j]
			err = scan(conn, "PRAGMA index_info("+quote(index.Name)+")", func(stmt *sqlite3.Stmt) error {
				index.Columns = append(index.Columns, nullableText(stmt, 2))
				return nil
			})
			if err != nil {
				return nil, err
			}
		}

		err = scan(conn, "PRAGMA foreign_key_list("+quote(table.Name)+")", func(stmt *sqlite3.Stmt) error {
			table.ForeignKeys = append(table.ForeignKeys, ForeignKey{
				ID: stmt.ColumnInt(0), Seq: stmt.ColumnInt(1), Table: stmt.ColumnText(2),
				From: stmt.ColumnText(3), To: nullableText(stmt, 4),
			})
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	return schema, nil
}
