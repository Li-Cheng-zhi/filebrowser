package workspace

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

var ErrPageExpired = errors.New("目录分页快照已失效，请刷新目录")

type Page struct {
	Items []json.RawMessage
	Meta  map[string]json.RawMessage
	Next  string
	Total int
}
type directory struct {
	key           string
	items         []json.RawMessage
	meta          map[string]json.RawMessage
	created, last time.Time
	bytes         int
}
type Pages struct {
	mu                 sync.Mutex
	entries            map[string]*directory
	Now                func() time.Time
	MaxBytes, MaxCount int
	Idle, Life         time.Duration
}

func NewPages() *Pages {
	return &Pages{entries: make(map[string]*directory), Now: time.Now, MaxBytes: 64 << 20, MaxCount: 16, Idle: 120 * time.Second, Life: 10 * time.Minute}
}
func (p *Pages) prune(now time.Time) {
	for id, d := range p.entries {
		if now.Sub(d.last) >= p.Idle || now.Sub(d.created) >= p.Life {
			delete(p.entries, id)
		}
	}
}
func (p *Pages) totalBytes() int {
	n := 0
	for _, d := range p.entries {
		n += d.bytes
	}
	return n
}
func (p *Pages) Create(key string, items []json.RawMessage, meta map[string]json.RawMessage, limit int) (Page, error) {
	return p.CreateOrder(key, items, meta, limit, "name", true)
}
func (p *Pages) CreateOrder(key string, items []json.RawMessage, meta map[string]json.RawMessage, limit int, field string, ascending bool) (Page, error) {
	if limit < 1 || limit > 1000 {
		return Page{}, errors.New("pageSize 必须为 1—1000 的整数")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.Now()
	p.prune(now)
	owned := make([]json.RawMessage, len(items))
	size := 0
	for i, item := range items {
		owned[i] = append(json.RawMessage(nil), item...)
		size += len(item)
	}
	metadata := make(map[string]json.RawMessage)
	for k, v := range meta {
		metadata[k] = append(json.RawMessage(nil), v...)
		size += len(v)
	}
	if size > p.MaxBytes {
		return Page{}, fmt.Errorf("单目录快照超过 %d 字节预算，未截断返回", p.MaxBytes)
	}
	// Sort the whole immutable snapshot before slicing, never just the visible page.
	type row struct {
		raw                json.RawMessage
		dir                bool
		name, exact, value string
		number             float64
	}
	rows := make([]row, len(owned))
	for i, raw := range owned {
		var item map[string]any
		_ = json.Unmarshal(raw, &item)
		name, _ := item["name"].(string)
		kind, _ := item["type"].(string)
		value := item[field]
		if field == "kind" {
			value = kind
		}
		number, _ := value.(float64)
		rows[i] = row{raw, kind == "directory", strings.ToLower(name), name, fmt.Sprint(value), number}
	}
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := rows[i], rows[j]
		if a.dir != b.dir {
			return a.dir
		}
		less, eq := false, false
		switch field {
		case "name":
			less = a.name < b.name
			eq = a.name == b.name
		case "size", "duration":
			less = a.number < b.number
			eq = a.number == b.number
		default:
			less = a.value < b.value
			eq = a.value == b.value
		}
		if eq {
			if a.name != b.name {
				return a.name < b.name
			}
			return a.exact < b.exact
		}
		if !ascending {
			return !less
		}
		return less
	})
	for i, row := range rows {
		owned[i] = row.raw
	}
	for len(p.entries) >= p.MaxCount || p.totalBytes()+size > p.MaxBytes {
		oldest := ""
		for id, d := range p.entries {
			if oldest == "" || d.last.Before(p.entries[oldest].last) {
				oldest = id
			}
		}
		if oldest == "" {
			break
		}
		delete(p.entries, oldest)
	}
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return Page{}, err
	}
	id := hex.EncodeToString(raw[:])
	p.entries[id] = &directory{key: key, items: owned, meta: metadata, created: now, last: now, bytes: size}
	return p.slice(id, 0, limit)
}
func (p *Pages) Next(key, cursor string, limit int) (Page, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.prune(p.Now())
	parts := strings.Split(cursor, ":")
	if len(parts) != 2 {
		return Page{}, ErrPageExpired
	}
	offset, err := strconv.Atoi(parts[1])
	d, ok := p.entries[parts[0]]
	if err != nil || !ok || d.key != key || offset < 0 || offset >= len(d.items) {
		return Page{}, ErrPageExpired
	}
	return p.slice(parts[0], offset, limit)
}
func (p *Pages) slice(id string, offset, limit int) (Page, error) {
	if limit < 1 || limit > 1000 {
		return Page{}, errors.New("pageSize 必须为 1—1000 的整数")
	}
	d := p.entries[id]
	d.last = p.Now()
	end := offset + limit
	if end > len(d.items) {
		end = len(d.items)
	}
	next := ""
	if end < len(d.items) {
		next = id + ":" + strconv.Itoa(end)
	}
	return Page{Items: d.items[offset:end], Meta: d.meta, Next: next, Total: len(d.items)}, nil
}
