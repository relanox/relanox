package line

import (
	"strings"
	"testing"
)

// Flex altText allows 1500 characters, counted as UTF-16 units by the source
// adapter. Short existing fixtures miss premature and surrogate truncation.
// https://developers.line.biz/en/reference/messaging-api/#flex-message
func TestFlexPreviewLength(t *testing.T) {
	for _, label := range []string{strings.Repeat("图", 1500), strings.Repeat("😀", 750)} {
		if got := flexContents(label+"😀", nil).AltText; got != label {
			t.Fatalf("preview length=%d want=%d", len(got), len(label))
		}
	}
}
