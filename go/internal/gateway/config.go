package gateway

import (
	"fmt"
	"net/netip"
	"time"

	"github.com/goccy/go-yaml"
)

const (
	StaticTarget  = "/etc/traefik/traefik.yml"
	DynamicTarget = "/etc/traefik/dynamic"
	PingAddress   = "127.0.0.1:8082"
	ProbeHost     = "gateway-probe.internal"
	ProbeFile     = "gateway-probe.yml"
	ProbeRouter   = "gateway-probe"

	TunnelProbeRouter   = "stationly-probe"
	TunnelProbePath     = "/.well-known/stationly-probe"
	TunnelProbeHeader   = "X-Stationly-Gateway"
	tunnelProbePriority = 1 << 30

	GraceTimeout = 30 * time.Second

	ReadTimeout            = 60 * time.Second
	IdleTimeout            = 120 * time.Second
	KeepAliveMaxTime       = 10 * time.Minute
	KeepAliveMaxRequests   = 10000
	MaxConcurrentStreams   = 100
	MaxHeaderBytes         = 64 << 10
	MaxHeaderValueCount    = 100
	AccessLogBufferingSize = 256
)

type (
	item   = yaml.MapItem
	object = yaml.MapSlice
)

func kv(k string, v any) item {
	return item{Key: k, Value: v}
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

func httpLimits() object {
	return object{
		kv("maxHeaderBytes", MaxHeaderBytes),
		kv("maxHeaderValueCount", MaxHeaderValueCount),
	}
}

func http2() object {
	return object{kv("maxConcurrentStreams", MaxConcurrentStreams)}
}

func StaticConfig(cloudflared netip.Addr) ([]byte, error) {
	if !cloudflared.IsValid() {
		return nil, fmt.Errorf("the Gateway's static configuration needs the cloudflared address")
	}
	doc := object{
		kv("global", object{kv("checkNewVersion", false), kv("sendAnonymousUsage", false)}),
		kv("entryPoints", object{
			kv("web", object{
				kv("address", ":80"),
				kv("forwardedHeaders", object{kv("trustedIPs", []string{netip.PrefixFrom(cloudflared, 32).String()})}),
				kv("http", httpLimits()),
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
	ID          string
	Hostname    string
	Upstream    netip.AddrPort
	Cloudflared netip.Addr
}

func hostRule(h string) string {
	return "Host(`" + h + "`)"
}

func RouteConfig(r Route) ([]byte, error) {
	if !r.Cloudflared.IsValid() {
		return nil, fmt.Errorf("route %s needs the cloudflared address", r.ID)
	}
	return yaml.Marshal(object{kv("http", object{
		kv("routers", object{kv(r.ID, object{
			kv("entryPoints", []string{"web"}),
			kv("rule", hostRule(r.Hostname)+" && ClientIP(`"+netip.PrefixFrom(r.Cloudflared, 32).String()+"`)"),
			kv("service", r.ID),
		})}),
		kv("services", object{kv(r.ID, object{kv("loadBalancer", object{
			kv("servers", []object{{kv("url", "http://"+r.Upstream.String())}}),
			kv("passHostHeader", true),
		})})}),
	})})
}

func ProbeConfig(bridgeGateway, cloudflared netip.Addr, probeID string) ([]byte, error) {
	marker := TunnelProbeRouter + "-id"
	return yaml.Marshal(object{kv("http", object{
		kv("routers", object{
			kv(ProbeRouter, object{
				kv("entryPoints", []string{"web"}),
				kv("rule", hostRule(ProbeHost)+" && ClientIP(`"+netip.PrefixFrom(bridgeGateway, 32).String()+"`)"),
				kv("service", "ping@internal"),
			}),
			kv(TunnelProbeRouter, object{
				kv("entryPoints", []string{"web"}),
				kv("rule", "PathPrefix(`"+TunnelProbePath+"`) && ClientIP(`"+netip.PrefixFrom(cloudflared, 32).String()+"`)"),
				kv("priority", tunnelProbePriority),
				kv("middlewares", []string{marker}),
				kv("service", "noop@internal"),
			}),
		}),
		kv("middlewares", object{kv(marker, object{kv("headers", object{kv("customResponseHeaders", object{kv(TunnelProbeHeader, probeID)})})})}),
	})})
}
