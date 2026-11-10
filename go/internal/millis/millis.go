package millis

import "time"

func Of(d time.Duration) float64 {
	return float64(d.Microseconds()) / 1000
}
