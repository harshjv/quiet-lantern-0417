package fakes3

import (
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
)

type Server struct {
	mu        sync.Mutex
	Access    string
	objects   map[string][]byte
	uploads   map[string]map[int][]byte
	aborted   int
	refused   int
	completed int
}

type Stats struct {
	Completed int
	Aborted   int
	Refused   int
	Open      int
	Objects   int
}

func (f *Server) Stats() Stats {
	f.mu.Lock()
	defer f.mu.Unlock()
	return Stats{Completed: f.completed, Aborted: f.aborted, Refused: f.refused, Open: len(f.uploads), Objects: len(f.objects)}
}

func (f *Server) Object(key string) ([]byte, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.objects[key]
	return data, ok
}

func (f *Server) Set(key string, data []byte) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = data
}

func (f *Server) Keys() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	keys := make([]string, 0, len(f.objects))
	for k := range f.objects {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func New(access string) *Server {
	return &Server{Access: access, objects: map[string][]byte{}, uploads: map[string]map[int][]byte{}}
}

func (f *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !strings.Contains(r.Header.Get("Authorization"), "Credential="+f.Access+"/") {
		f.refused++
		http.Error(w, `<Error><Code>InvalidAccessKeyId</Code></Error>`, http.StatusForbidden)
		return
	}
	key := strings.TrimPrefix(r.URL.Path, "/")
	q := r.URL.Query()
	body, _ := io.ReadAll(r.Body)
	switch {
	case r.Method == http.MethodPost && q.Has("uploads"):
		id := fmt.Sprintf("u%d", len(f.uploads)+1)
		f.uploads[id] = map[int][]byte{}
		fmt.Fprintf(w, `<InitiateMultipartUploadResult><Bucket>b</Bucket><Key>%s</Key><UploadId>%s</UploadId></InitiateMultipartUploadResult>`, key, id)
	case r.Method == http.MethodPut && q.Has("partNumber"):
		n, _ := strconv.Atoi(q.Get("partNumber"))
		f.uploads[q.Get("uploadId")][n] = body
		w.Header().Set("ETag", fmt.Sprintf(`"etag%d"`, n))
	case r.Method == http.MethodPost && q.Has("uploadId"):
		var req struct {
			Parts []struct{ PartNumber int } `xml:"Part"`
		}
		if err := xml.Unmarshal(body, &req); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		var all []byte
		numbers := []int{}
		for _, p := range req.Parts {
			numbers = append(numbers, p.PartNumber)
		}
		sort.Ints(numbers)
		for _, n := range numbers {
			all = append(all, f.uploads[q.Get("uploadId")][n]...)
		}
		f.objects[key] = all
		f.completed++
		delete(f.uploads, q.Get("uploadId"))
		fmt.Fprintf(w, `<CompleteMultipartUploadResult><Key>%s</Key></CompleteMultipartUploadResult>`, key)
	case r.Method == http.MethodDelete && q.Has("uploadId"):
		delete(f.uploads, q.Get("uploadId"))
		f.aborted++
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPut:
		f.objects[key] = body
	case r.Method == http.MethodGet || r.Method == http.MethodHead:
		data, ok := f.objects[key]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			if r.Method == http.MethodGet {
				_, _ = io.WriteString(w, `<Error><Code>NoSuchKey</Code></Error>`)
			}
			return
		}
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		if r.Method == http.MethodGet {
			_, _ = w.Write(data)
		}
	case r.Method == http.MethodDelete:
		delete(f.objects, key)
		w.WriteHeader(http.StatusNoContent)
	default:
		http.Error(w, "unsupported", http.StatusBadRequest)
	}
}
