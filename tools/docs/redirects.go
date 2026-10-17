package main

import (
	"bytes"
	"fmt"
	"html/template"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

func validateRedirectBase(base string) error {
	if base == "" {
		return nil
	}
	target, err := url.Parse(base)
	if err != nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.RawQuery != "" || target.Fragment != "" || !strings.HasSuffix(base, "/") {
		return fmt.Errorf("redirect_base_must_be_an_https_directory_url")
	}
	return nil
}

// Retain published VitePress URLs after the Go documentation migration.
func writeLegacyRedirects(out, base string) error {
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
			if err := writeSiteRedirect(out, base, language+"/"+alias, language+"/"+target); err != nil {
				return err
			}
		}
		if err := writeSiteRedirect(out, base, language+"/reference/sdk.html", "en/architecture.html"); err != nil {
			return err
		}
		if err := writeRedirect(out, language+"/reference/licenses.html", "https://github.com/relanox/relanox/blob/master/licenses/README.md"); err != nil {
			return err
		}
	}
	for _, page := range []string{"architecture.html", "development.html"} {
		if err := writeSiteRedirect(out, base, "zh-CN/"+page, "en/"+page); err != nil {
			return err
		}
	}
	return nil
}

func writeSiteRedirect(out, base, alias, target string) error {
	if base == "" {
		base = strings.Repeat("../", strings.Count(alias, "/"))
	}
	return writeRedirect(out, alias, base+target)
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
