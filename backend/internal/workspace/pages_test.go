package workspace

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPagesImmutableScopeExpiryAndNoMissingItems(t *testing.T) {
	p := NewPages()
	now := time.Unix(0, 0)
	p.Now = func() time.Time { return now }
	items := []json.RawMessage{json.RawMessage(`{"name":"c","type":"file"}`), json.RawMessage(`{"name":"b","type":"directory"}`), json.RawMessage(`{"name":"a","type":"file"}`)}
	first, e := p.Create("host:source:dir", items, nil, 2)
	if e != nil {
		t.Fatal(e)
	}
	if first.Total != 3 || first.Next == "" {
		t.Fatal(first)
	}
	items[0][0] = '!' // caller changes its own data; snapshot must remain immutable
	last, e := p.Next("host:source:dir", first.Next, 2)
	if e != nil || len(last.Items) != 1 || last.Next != "" {
		t.Fatalf("%v %v", last, e)
	}
	if !json.Valid(last.Items[0]) {
		t.Fatal("snapshot aliases caller data")
	}
	if _, e = p.Next("other-workspace", first.Next, 2); !errors.Is(e, ErrPageExpired) {
		t.Fatal(e)
	}
	now = now.Add(121 * time.Second)
	if _, e = p.Next("host:source:dir", first.Next, 2); !errors.Is(e, ErrPageExpired) {
		t.Fatal(e)
	}
}
func TestPageBudgetEvictsInsteadOfTruncating(t *testing.T) {
	p := NewPages()
	p.MaxCount = 1
	items := []json.RawMessage{json.RawMessage(`{"name":"a"}`), json.RawMessage(`{"name":"b"}`)}
	first, _ := p.Create("a", items, nil, 1)
	_, _ = p.Create("b", items, nil, 1)
	if _, e := p.Next("a", first.Next, 1); !errors.Is(e, ErrPageExpired) {
		t.Fatal(e)
	}
	p.MaxBytes = 1
	if _, e := p.Create("too-large", items, nil, 1); e == nil {
		t.Fatal("budget silently truncated")
	}
}

func TestGlobalOrderPrecedesPageSlicing(t *testing.T) {
	p := NewPages()
	items := []json.RawMessage{json.RawMessage(`{"name":"z","type":"file","size":1}`), json.RawMessage(`{"name":"a","type":"file","size":9}`), json.RawMessage(`{"name":"dir","type":"directory","size":0}`)}
	first, e := p.CreateOrder("size-desc", items, nil, 1, "size", false)
	if e != nil {
		t.Fatal(e)
	}
	var names []string
	page := first
	for {
		var item struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(page.Items[0], &item)
		names = append(names, item.Name)
		if page.Next == "" {
			break
		}
		page, e = p.Next("size-desc", page.Next, 1)
		if e != nil {
			t.Fatal(e)
		}
	}
	if strings.Join(names, ",") != "dir,a,z" {
		t.Fatal(names)
	}
}
