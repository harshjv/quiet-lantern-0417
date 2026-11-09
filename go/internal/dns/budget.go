package dns

import (
	"net/netip"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const (
	budgetRate    rate.Limit = 1000
	budgetBurst              = 2000
	budgetIdle               = 10 * time.Second
	budgetSweep              = time.Second
	budgetMaxSrcs            = 4096
)

type bucket struct {
	limiter *rate.Limiter
	seen    time.Time
}

type budgets struct {
	mu        sync.Mutex
	now       func() time.Time
	bySource  map[netip.Addr]*bucket
	lastSweep time.Time
}

func newBudgets() *budgets {
	return &budgets{now: time.Now, bySource: map[netip.Addr]*bucket{}}
}

func (b *budgets) allow(src netip.Addr) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	now := b.now()
	if now.Sub(b.lastSweep) >= budgetSweep {
		b.evictIdle(now)
	}
	bk := b.bySource[src]
	if bk == nil {
		if len(b.bySource) >= budgetMaxSrcs {
			return false
		}
		bk = &bucket{limiter: rate.NewLimiter(budgetRate, budgetBurst)}
		b.bySource[src] = bk
	}
	bk.seen = now
	return bk.limiter.AllowN(now, 1)
}

func (b *budgets) evictIdle(now time.Time) {
	b.lastSweep = now
	for src, bk := range b.bySource {
		if now.Sub(bk.seen) >= budgetIdle {
			delete(b.bySource, src)
		}
	}
}

func (b *budgets) tracked() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.bySource)
}
