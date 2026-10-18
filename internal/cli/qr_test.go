package cli

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"strings"
	"testing"

	"github.com/makiuchi-d/gozxing"
	"github.com/makiuchi-d/gozxing/qrcode"
)

// Pairing must show a scannable QR while keeping stdout machine-readable.
// Existing native login tests only assert saved credentials. Decode the actual
// terminal cells with an independent ZXing implementation, not the encoder.
func TestWechatQRIsScannableAndDoesNotPolluteJSON(t *testing.T) {
	const link = "https://weixin.qq.com/qrcode/native-pairing"
	var out, diagnostic bytes.Buffer
	c := &command{json: true, options: Options{Out: &out, Err: &diagnostic}}
	if err := c.wechatEvent(map[string]any{"event": "wechat_qrcode", "qrCode": link}, ""); err != nil {
		t.Fatal(err)
	}
	var event map[string]string
	if err := json.Unmarshal(out.Bytes(), &event); err != nil || event["qrCode"] != link {
		t.Fatalf("JSON stream contaminated: %q %v", out.String(), err)
	}
	bitmap, err := gozxing.NewBinaryBitmapFromImage(terminalQR(t, diagnostic.String()))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := qrcode.NewQRCodeReader().Decode(bitmap, nil)
	if err != nil || decoded.GetText() != link {
		t.Fatalf("terminal QR does not encode native link: %v %v", decoded, err)
	}
}

func terminalQR(t *testing.T, output string) image.Image {
	t.Helper()
	var rows [][]rune
	for _, line := range strings.Split(output, "\n") {
		if line != "" && strings.Trim(line, " █▀▄") == "" {
			rows = append(rows, []rune(line))
		}
	}
	if len(rows) == 0 {
		t.Fatal("no terminal QR cells were written")
	}
	const scale = 4
	result := image.NewGray(image.Rect(0, 0, len(rows[0])*scale, len(rows)*2*scale))
	for y, row := range rows {
		for x, cell := range row {
			paintQRCell(result, x, y*2, scale, cell == '█' || cell == '▀')
			paintQRCell(result, x, y*2+1, scale, cell == '█' || cell == '▄')
		}
	}
	return result
}

func paintQRCell(result *image.Gray, x, y, scale int, white bool) {
	value := color.Gray{}
	if white {
		value.Y = 255
	}
	for dy := range scale {
		for dx := range scale {
			result.SetGray(x*scale+dx, y*scale+dy, value)
		}
	}
}
