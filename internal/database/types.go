package database

type Request struct {
	Action       string  `json:"action"`
	Path         string  `json:"path"`
	Timeout      float64 `json:"timeout"`
	SQL          string  `json:"sql"`
	Table        string  `json:"table"`
	Limit        int     `json:"limit"`
	Offset       int64   `json:"offset"`
	Sort         string  `json:"sort"`
	Descending   bool    `json:"descending"`
	FilterColumn string  `json:"filterColumn"`
	FilterValue  string  `json:"filterValue"`
}

type Result struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	HasMore   bool     `json:"hasMore"`
	Offset    int64    `json:"offset"`
	Limit     int      `json:"limit"`
	ElapsedMs int64    `json:"elapsedMs"`
}

type Schema struct {
	Name          string  `json:"name"`
	Path          string  `json:"path"`
	Size          int64   `json:"size"`
	SQLiteVersion string  `json:"sqliteVersion"`
	Tables        []Table `json:"tables"`
	ElapsedMs     int64   `json:"elapsedMs"`
}

type Table struct {
	Name        string       `json:"name"`
	Type        string       `json:"type"`
	SQL         string       `json:"sql"`
	Columns     []Column     `json:"columns"`
	Indexes     []Index      `json:"indexes"`
	ForeignKeys []ForeignKey `json:"foreignKeys"`
}

type Column struct {
	Name    string  `json:"name"`
	Type    string  `json:"type"`
	NotNull bool    `json:"notNull"`
	Default *string `json:"default"`
	PK      int     `json:"pk"`
	Hidden  int     `json:"hidden"`
}

type Index struct {
	Name    string    `json:"name"`
	Unique  bool      `json:"unique"`
	Origin  string    `json:"origin"`
	Partial bool      `json:"partial"`
	Columns []*string `json:"columns"`
}

type ForeignKey struct {
	ID    int     `json:"id"`
	Seq   int     `json:"seq"`
	Table string  `json:"table"`
	From  string  `json:"from"`
	To    *string `json:"to"`
}

type BlobPreview struct {
	Type  string `json:"type"`
	Bytes int64  `json:"bytes"`
}

type TextPreview struct {
	Type      string `json:"type"`
	Preview   string `json:"preview"`
	Truncated bool   `json:"truncated"`
}

type ExactNumber struct {
	Type  string `json:"type"`
	Value string `json:"value"`
}
