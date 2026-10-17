package config

import (
	"regexp"
	"slices"
)

var speechEngines = []string{"8k_zh", "8k_en", "16k_zh", "16k_zh-PY", "16k_zh_medical", "16k_en", "16k_yue", "16k_ja", "16k_ko", "16k_vi", "16k_ms", "16k_id", "16k_fil", "16k_th", "16k_pt", "16k_tr", "16k_ar", "16k_es", "16k_hi", "16k_fr", "16k_de", "16k_zh_dialect"}

// ValidateSpeech checks native ASR options without resolving credentials or
// opening connections. The same boundary validates retained preparation plans.
func ValidateSpeech(speech Speech) error {
	if !speech.Enabled {
		return nil
	}
	if err := ValidateSecretRef(speech.SecretID, "speech.secretId"); err != nil {
		return err
	}
	if err := ValidateSecretRef(speech.SecretKey, "speech.secretKey"); err != nil {
		return err
	}
	if speech.EngineModelType != "" && !slices.Contains(speechEngines, speech.EngineModelType) {
		return invalid("speech.engineModelType", "unsupported_engine")
	}
	if speech.Region != "" && !regexp.MustCompile(`^[a-z][a-z0-9-]{1,63}$`).MatchString(speech.Region) {
		return invalid("speech.region", "invalid_region")
	}
	return nil
}
