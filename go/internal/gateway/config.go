package gateway

import (
	"fmt"
	"net/netip"
	"strconv"
	"time"

	"github.com/goccy/go-yaml"
)

const (
	StaticTarget  = "/etc/traefik/traefik.yml"
	DynamicTarget = "/etc/traefik/dynamic"
	DataTarget    = "/data"
	PingAddress   = "127.0.0.1:8082"
	ProbeHost     = "gateway-probe.internal"
	ProbeFile     = "gateway-probe.yml"
	ProbeRouter   = "gateway-probe"
	CAFileName    = "acme-ca.pem"

	ResolverClassic    = "letsencrypt"
	ResolverShortlived = "letsencrypt-shortlived"
	ShortlivedHours    = 160
	KeyType            = "EC256"
	GraceTimeout       = 30 * time.Second

	ReadTimeout            = 60 * time.Second
	IdleTimeout            = 120 * time.Second
	KeepAliveMaxTime       = 10 * time.Minute
	KeepAliveMaxRequests   = 10000
	MaxConcurrentStreams   = 100
	MaxHeaderBytes         = 64 << 10
	MaxHeaderValueCount    = 100
	AccessLogBufferingSize = 256
)

type item = yaml.MapItem
type object = yaml.MapSlice

func kv(k string, v any) item {
	return item{Key: k, Value: v}
}

type Static struct {
	Email          string
	CAServer       string
	CACertificates bool
	Store          int
	Cloudflared    netip.Addr
}

func StoreName(n int) string {
	return "acme." + strconv.Itoa(n) + ".json"
}

func ClassicHours(now time.Time) int {
	switch {
	case !now.Before(time.Date(2028, 2, 16, 0, 0, 0, 0, time.UTC)):
		return 1080
	case !now.Before(time.Date(2027, 2, 10, 0, 0, 0, 0, time.UTC)):
		return 1536
	default:
		return 2160
	}
}

func transport() object {
	return object{
		kv("lifeCycle", object{
			kv("graceTimeOut", GraceTimeout.String()),
			kv("requestAcceptGraceTimeout", "0s"),
		}),
		kv("respondingTimeouts", object{
			kv("readTimeout", ReadTimeout.String()),
			kv("writeTimeout", "0s"),
			kv("idleTimeout", IdleTimeout.String()),
		}),
		kv("keepAliveMaxTime", KeepAliveMaxTime.String()),
		kv("keepAliveMaxRequests", KeepAliveMaxRequests),
	}
}

func httpLimits(extra ...item) object {
	return append(object{
		kv("maxHeaderBytes", MaxHeaderBytes),
		kv("maxHeaderValueCount", MaxHeaderValueCount),
	}, extra...)
}

func http2() object {
	return object{kv("maxConcurrentStreams", MaxConcurrentStreams)}
}

func resolver(s Static, shortlived bool, classicHours int) object {
	acme := object{}
	if s.Email != "" {
		acme = append(acme, kv("email", s.Email))
	}
	acme = append(acme, kv("storage", DataTarget+"/"+StoreName(s.Store)), kv("keyType", KeyType))
	if s.CAServer != "" {
		acme = append(acme, kv("caServer", s.CAServer))
	}
	if s.CACertificates {
		acme = append(acme, kv("caCertificates", []string{DataTarget + "/" + CAFileName}), kv("caSystemCertPool", true))
	}
	if shortlived {
		acme = append(acme, kv("profile", "shortlived"), kv("disableCommonName", true), kv("certificatesDuration", ShortlivedHours))
	} else {
		acme = append(acme, kv("certificatesDuration", classicHours))
	}
	acme = append(acme, kv("httpChallenge", object{kv("entryPoint", "web")}))
	return object{kv("acme", acme)}
}

func StaticConfig(s Static, classicHours int) ([]byte, error) {
	web := object{kv("address", ":80")}
	if s.Cloudflared.IsValid() {
		web = append(web, kv("forwardedHeaders", object{kv("trustedIPs", []string{netip.PrefixFrom(s.Cloudflared, 32).String()})}))
	}
	web = append(web, kv("http", httpLimits()), kv("http2", http2()), kv("transport", transport()))
	doc := object{
		kv("global", object{kv("checkNewVersion", false), kv("sendAnonymousUsage", false)}),
		kv("entryPoints", object{
			kv("web", web),
			kv("websecure", object{
				kv("address", ":443"),
				kv("http", httpLimits(kv("tls", object{kv("certResolver", ResolverClassic)}))),
				kv("http2", http2()),
				kv("transport", transport()),
			}),
			kv("traefik", object{kv("address", PingAddress)}),
		}),
		kv("ping", object{kv("entryPoint", "traefik")}),
		kv("providers", object{
			kv("file", object{kv("directory", DynamicTarget), kv("watch", true)}),
			kv("providersThrottleDuration", "2s"),
		}),
		kv("certificatesResolvers", object{
			kv(ResolverClassic, resolver(s, false, classicHours)),
			kv(ResolverShortlived, resolver(s, true, classicHours)),
		}),
		kv("api", object{kv("dashboard", false)}),
		kv("log", object{kv("level", "INFO"), kv("format", "json")}),
		kv("accessLog", object{
			kv("format", "json"),
			kv("bufferingSize", AccessLogBufferingSize),
			kv("fields", object{kv("headers", object{kv("names", object{
				kv("Cf-Connecting-Ip", "keep"),
				kv("Cf-Ray", "keep"),
			})})}),
		}),
	}
	return yaml.Marshal(doc)
}

type Route struct {
	ID           string
	Hostname     string
	Tunnel       bool
	Upstream     netip.AddrPort
	Resolver     string
	RedirectHTTP bool
	Cloudflared  netip.Addr
}

func hostRule(h string) string {
	return "Host(`" + h + "`)"
}

var stripCF = object{
	kv("Cf-Connecting-Ip", ""),
	kv("Cf-Access-Jwt-Assertion", ""),
	kv("Cf-Ray", ""),
	kv("Cf-Ipcountry", ""),
	kv("Cf-Visitor", ""),
}

func (r Route) service() object {
	return object{kv(r.ID, object{kv("loadBalancer", object{
		kv("servers", []object{{kv("url", "http://"+r.Upstream.String())}}),
		kv("passHostHeader", true),
	})})}
}

func RouteConfig(r Route) ([]byte, error) {
	if r.Tunnel {
		if !r.Cloudflared.IsValid() {
			return nil, fmt.Errorf("route %s: a tunnel route needs the cloudflared address", r.ID)
		}
		return yaml.Marshal(object{kv("http", object{
			kv("routers", object{kv(r.ID, object{
				kv("entryPoints", []string{"web"}),
				kv("rule", hostRule(r.Hostname)+" && ClientIP(`"+netip.PrefixFrom(r.Cloudflared, 32).String()+"`)"),
				kv("service", r.ID),
			})}),
			kv("services", r.service()),
		})})
	}
	routers := object{}
	middlewares := object{}
	strip := r.ID + "-strip-cf"
	if r.RedirectHTTP {
		https := r.ID + "-https"
		routers = append(routers, kv(r.ID+"-redirect", object{
			kv("entryPoints", []string{"web"}),
			kv("rule", hostRule(r.Hostname)),
			kv("middlewares", []string{https}),
			kv("service", "noop@internal"),
		}))
		middlewares = append(middlewares, kv(https, object{kv("redirectScheme", object{kv("scheme", "https"), kv("permanent", true)})}))
	} else {
		routers = append(routers, kv(r.ID+"-http", object{
			kv("entryPoints", []string{"web"}),
			kv("rule", hostRule(r.Hostname)),
			kv("middlewares", []string{strip}),
			kv("service", r.ID),
		}))
	}
	secure := object{
		kv("entryPoints", []string{"websecure"}),
		kv("rule", hostRule(r.Hostname)),
		kv("middlewares", []string{strip}),
		kv("service", r.ID),
	}
	if r.Resolver != "" {
		secure = append(secure, kv("tls", object{kv("certResolver", r.Resolver)}))
	}
	routers = append(routers, kv(r.ID, secure))
	middlewares = append(middlewares, kv(strip, object{kv("headers", object{kv("customRequestHeaders", stripCF)})}))
	doc := object{kv("http", object{
		kv("routers", routers),
		kv("middlewares", middlewares),
		kv("services", r.service()),
	})}
	if ip, err := netip.ParseAddr(r.Hostname); err == nil && r.Resolver != "" {
		doc = append(doc, kv("tls", object{kv("stores", object{kv("default", object{
			kv("defaultGeneratedCert", object{
				kv("resolver", r.Resolver),
				kv("domain", object{kv("main", ip.String())}),
			}),
		})})}))
	}
	return yaml.Marshal(doc)
}

func ProbeConfig(bridgeGateway netip.Addr) ([]byte, error) {
	return yaml.Marshal(object{kv("http", object{kv("routers", object{kv(ProbeRouter, object{
		kv("entryPoints", []string{"web"}),
		kv("rule", hostRule(ProbeHost)+" && ClientIP(`"+netip.PrefixFrom(bridgeGateway, 32).String()+"`)"),
		kv("service", "ping@internal"),
	})})})})
}
