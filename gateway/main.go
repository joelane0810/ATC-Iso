// Cổng Tailscale riêng cho ATC Iso: tham gia mạng Tailscale như một máy tên "atc-iso"
// và chuyển mọi truy cập về máy chủ app trên chính máy này (127.0.0.1:4317).
// Không đụng tới tên máy Mac. Đổi sang mạng khác thì tắt cổng này, chọn cách truy cập khác trong config.json.
package main

import (
	"context"
	"crypto/tls"
	"flag"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	"tailscale.com/tsnet"
)

func main() {
	hostname := flag.String("hostname", "atc-iso", "tên máy trong mạng Tailscale")
	target := flag.String("target", "http://127.0.0.1:4317", "máy chủ app")
	dir := flag.String("dir", "", "thư mục lưu trạng thái đăng nhập")
	flag.Parse()

	upstream, err := url.Parse(*target)
	if err != nil {
		log.Fatal(err)
	}
	srv := &tsnet.Server{Hostname: *hostname, Dir: *dir, UserLogf: log.Printf}
	defer srv.Close()

	proxy := httputil.NewSingleHostReverseProxy(upstream)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("X-Forwarded-Host", r.Host)
		proxy.ServeHTTP(w, r)
	})

	// http://atc-iso (cổng 80)
	ln80, err := srv.Listen("tcp", ":80")
	if err != nil {
		log.Fatal(err)
	}
	go func() { log.Fatal(http.Serve(ln80, handler)) }()

	// https://atc-iso.<mạng>.ts.net nếu mạng đã bật chứng chỉ HTTPS; không có thì chỉ dùng http.
	lc, err := srv.LocalClient()
	if err != nil {
		log.Fatal(err)
	}
	ln443, err := srv.Listen("tcp", ":443")
	if err != nil {
		log.Fatal(err)
	}
	tlsLn := tls.NewListener(ln443, &tls.Config{GetCertificate: func(h *tls.ClientHelloInfo) (*tls.Certificate, error) {
		if !strings.Contains(h.ServerName, ".") {
			return nil, nil
		}
		return lc.GetCertificate(h)
	}})
	status, err := srv.Up(context.Background())
	if err != nil {
		log.Fatal(err)
	}
	ips := []string{}
	for _, ip := range status.TailscaleIPs {
		ips = append(ips, ip.String())
	}
	dnsName := ""
	if status.Self != nil {
		dnsName = strings.TrimSuffix(status.Self.DNSName, ".")
	}
	log.Printf("Cổng ATC Iso sẵn sàng: http://%s ip=%s dns=%s", *hostname, strings.Join(ips, ","), dnsName)
	log.Fatal(http.Serve(tlsLn, handler))
}
