package common

import (
	"strings"

	"github.com/relanox/relanox/internal/model"
	"github.com/relanox/relanox/internal/text"
)

// ValidateRich checks the native envelope against the exact owned media resolved
// by Core. It never loads bytes from identifiers supplied by a remote caller.
func ValidateRich(input model.SendInput, limits model.RichTextLimits, unit model.LengthUnit, maximum int64) string {
	parts := input.Chunk.RichText
	if len(parts) == 0 {
		return ""
	}
	if input.Chunk.Text != "" || input.Chunk.Media != nil || input.Media != nil || len(parts) > limits.MaxParts {
		return "invalid_rich_text"
	}
	var fragments []string
	images, total := 0, int64(0)
	for _, part := range parts {
		if part.Type == "text" {
			fragments = append(fragments, part.Text)
			continue
		}
		if part.Type != "image" || part.Media == nil || images >= len(input.RichMedia) {
			return "invalid_rich_media"
		}
		media := input.RichMedia[images]
		images++
		ref := part.Media
		stored := media.Reference
		if ref.Kind != model.Image || stored.Kind != model.Image || ref.ID != stored.ID || ref.MIMEType != stored.MIMEType || ref.Size != stored.Size || ref.SHA256 != stored.SHA256 || ref.FileName != stored.FileName || int64(len(media.Data)) != ref.Size || len(media.Data) == 0 {
			return "invalid_rich_media"
		}
		if len(limits.ImageMIMETypes) > 0 && !Contains(limits.ImageMIMETypes, ref.MIMEType) {
			return "invalid_rich_media"
		}
		limit := maximum
		if limits.MaxImageBytes > 0 {
			limit = min(limit, limits.MaxImageBytes)
		}
		if limit > 0 && int64(len(media.Data)) > limit {
			return "invalid_rich_media"
		}
		if text.Length(part.Label, model.UTF16) > 2000 {
			return "invalid_rich_media"
		}
		total += int64(len(media.Data))
	}
	if images == 0 || images != len(input.RichMedia) {
		return "invalid_rich_media"
	}
	if limits.MaxTotalImageBytes > 0 && total > limits.MaxTotalImageBytes {
		return "invalid_rich_media"
	}
	if text.Length(strings.Join(fragments, ""), unit) > limits.MaxTextLength {
		return "rich_text_limit_exceeded"
	}
	return ""
}
