package main

import (
	"bytes"
	"html/template"
	"os"
	"path/filepath"
	"strings"
)

// Retain published URLs whose topics moved into the current Go documentation.
func writeLegacyRedirects(out string) error {
	aliases := map[string]string{
		"index.html": "quickstart.html", "getting-started.html": "quickstart.html",
		"connect.html": "quickstart.html", "media.html": "configuration.html",
		"channels/index.html":   "channels.html",
		"reference/agents.html": "agents.html", "reference/channels.html": "channels.html",
		"reference/configuration.html": "configuration.html", "reference/core.html": "operations.html",
		"reference/media.html": "configuration.html", "reference/observability.html": "operations.html",
	}
	for _, channel := range strings.Fields("dingtalk discord feishu googlechat irc line matrix mattermost msteams qq signal slack telegram wechat wecom whatsapp") {
		aliases["channels/"+channel+".html"] = "channels.html"
	}
	for _, language := range []string{"en", "zh-CN"} {
		for alias, target := range aliases {
			if err := writeSiteRedirect(out, language+"/"+alias, language+"/"+target); err != nil {
				return err
			}
		}
		if err := writeSiteRedirect(out, language+"/reference/sdk.html", "en/architecture.html"); err != nil {
			return err
		}
		if err := writeMissingRedirect(out, language+"/reference/licenses.html", "https://github.com/relanox/relanox/blob/master/licenses/README.md"); err != nil {
			return err
		}
	}
	for _, page := range []string{"architecture.html", "development.html"} {
		if err := writeSiteRedirect(out, "zh-CN/"+page, "en/"+page); err != nil {
			return err
		}
	}
	return nil
}

func writeSiteRedirect(out, alias, target string) error {
	base := strings.Repeat("../", strings.Count(alias, "/"))
	return writeMissingRedirect(out, alias, base+target)
}

func writeMissingRedirect(out, alias, target string) error {
	file := filepath.Join(out, filepath.FromSlash(alias))
	if _, err := os.Stat(file); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	return writeRedirect(out, alias, target)
}

func writeRedirect(out, alias, target string) error {
	var body bytes.Buffer
	if err := redirectLayout.Execute(&body, target); err != nil {
		return err
	}
	file := filepath.Join(out, filepath.FromSlash(alias))
	if err := os.MkdirAll(filepath.Dir(file), 0755); err != nil {
		return err
	}
	return os.WriteFile(file, body.Bytes(), 0644)
}

var redirectLayout = template.Must(template.New("redirect").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Relanox documentation</title>
<link rel="canonical" href="{{.}}"><script>location.replace({{.}} + location.search + location.hash)</script>
</head><body><p>Continue to <a href="{{.}}">Relanox documentation</a>.</p></body></html>
`))
