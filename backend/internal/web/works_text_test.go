package web

import "testing"

func TestWorksTextDoesNotSilentlyNormalizeUnsupportedLineEndings(t *testing.T) {
	for _, s := range []string{"\ufeff中文 😀\r\n末尾\r\n", "普通\n文本\n", "no final newline"} {
		if ok, _ := worksTextEditable([]byte(s)); !ok {
			t.Fatal(s)
		}
	}
	for _, s := range []string{"mixed\r\nline\n", "old\rmac\r"} {
		if ok, reason := worksTextEditable([]byte(s)); ok || reason == "" {
			t.Fatal(s)
		}
	}
}
