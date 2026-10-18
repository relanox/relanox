package cli

import (
	"strconv"
	"time"
)

// Numeric operator timeouts use seconds; explicit units remain available.
type secondsDuration time.Duration

func (v *secondsDuration) Set(value string) error {
	if _, err := strconv.ParseInt(value, 10, 64); err == nil {
		value += "s"
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return err
	}
	*v = secondsDuration(duration)
	return nil
}

func (v *secondsDuration) String() string { return time.Duration(*v).String() }
func (*secondsDuration) Type() string     { return "seconds-or-duration" }
