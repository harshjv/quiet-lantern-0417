package s3store

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const (
	PartSize        = 32 << 20
	MaxParts        = 10000
	defaultRegion   = "us-east-1"
	awsSuffix       = ".amazonaws.com"
	r2Suffix        = ".r2.cloudflarestorage.com"
	headerTimeout   = 60 * time.Second
	maxIdleHostConn = 4
)

var (
	bucketPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`)
	prefixPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)
	awsRegion     = regexp.MustCompile(`^s3[.-]([a-z0-9-]+)$`)
)

type Target struct {
	Endpoint string
	Bucket   string
	Prefix   string
}

type Credentials struct {
	AccessKeyID     string
	SecretAccessKey string
}

func ValidateEndpoint(endpoint string) error {
	u, err := url.Parse(endpoint)
	if err != nil || u.Host == "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return fmt.Errorf("endpoint %q is not an origin URL", endpoint)
	}
	if u.Scheme == "https" {
		return nil
	}
	addr, err := netip.ParseAddr(u.Hostname())
	if u.Scheme == "http" && err == nil && (addr.IsPrivate() || addr.IsLoopback()) {
		return nil
	}
	return fmt.Errorf("endpoint %q is not an https URL, nor an http URL on a private or loopback address", endpoint)
}

func (t Target) Validate() error {
	if err := ValidateEndpoint(t.Endpoint); err != nil {
		return err
	}
	if !bucketPattern.MatchString(t.Bucket) {
		return fmt.Errorf("bucket %q is not a bucket name", t.Bucket)
	}
	if t.Prefix != "" && (!prefixPattern.MatchString(t.Prefix) || slices.ContainsFunc(strings.Split(t.Prefix, "/"), func(s string) bool { return s == "." || s == ".." })) {
		return fmt.Errorf("prefix %q must be empty or slash-separated names of letters, digits, '.', '_' and '-'", t.Prefix)
	}
	return nil
}

func regionOf(host string) string {
	switch {
	case strings.HasSuffix(host, r2Suffix):
		return "auto"
	case strings.HasSuffix(host, awsSuffix):
		if m := awsRegion.FindStringSubmatch(strings.TrimSuffix(host, awsSuffix)); m != nil && m[1] != "dualstack" {
			return m[1]
		}
	}
	return defaultRegion
}

type Client struct {
	api    *s3.Client
	bucket string
	prefix string
}

func New(t Target, c Credentials) (*Client, error) {
	if err := t.Validate(); err != nil {
		return nil, err
	}
	if c.AccessKeyID == "" || c.SecretAccessKey == "" {
		return nil, errors.New("the S3 credentials are empty")
	}
	u, _ := url.Parse(t.Endpoint)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = headerTimeout
	transport.MaxIdleConnsPerHost = maxIdleHostConn
	api := s3.New(s3.Options{
		Region:       regionOf(u.Hostname()),
		BaseEndpoint: aws.String(strings.TrimSuffix(t.Endpoint, "/")),
		UsePathStyle: !strings.HasSuffix(u.Hostname(), awsSuffix),
		Credentials: aws.CredentialsProviderFunc(func(context.Context) (aws.Credentials, error) {
			return aws.Credentials{AccessKeyID: c.AccessKeyID, SecretAccessKey: c.SecretAccessKey, Source: "stationly"}, nil
		}),
		HTTPClient: &http.Client{
			Transport:     transport,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		},
		RequestChecksumCalculation: aws.RequestChecksumCalculationWhenRequired,
		ResponseChecksumValidation: aws.ResponseChecksumValidationWhenRequired,
	})
	return &Client{api: api, bucket: t.Bucket, prefix: t.Prefix}, nil
}

func (c *Client) Key(name string) string {
	if c.prefix == "" {
		return name
	}
	return c.prefix + "/" + name
}

func IsNotFound(err error) bool {
	var nf *types.NotFound
	var nk *types.NoSuchKey
	var api smithy.APIError
	if errors.As(err, &nf) || errors.As(err, &nk) {
		return true
	}
	return errors.As(err, &api) && (api.ErrorCode() == "NotFound" || api.ErrorCode() == "NoSuchKey")
}

func (c *Client) Head(ctx context.Context, name string) (int64, error) {
	out, err := c.api.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &c.bucket, Key: aws.String(c.Key(name))})
	if err != nil {
		return 0, err
	}
	return aws.ToInt64(out.ContentLength), nil
}

func (c *Client) Get(ctx context.Context, name string) (io.ReadCloser, int64, error) {
	out, err := c.api.GetObject(ctx, &s3.GetObjectInput{Bucket: &c.bucket, Key: aws.String(c.Key(name))})
	if err != nil {
		return nil, 0, err
	}
	return out.Body, aws.ToInt64(out.ContentLength), nil
}

func (c *Client) Delete(ctx context.Context, name string) error {
	_, err := c.api.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &c.bucket, Key: aws.String(c.Key(name))})
	return err
}

func (c *Client) PutBytes(ctx context.Context, name string, body []byte) error {
	_, err := c.api.PutObject(ctx, &s3.PutObjectInput{Bucket: &c.bucket, Key: aws.String(c.Key(name)), Body: bytes.NewReader(body), ContentLength: aws.Int64(int64(len(body)))})
	return err
}

type part struct {
	buf []byte
	n   int
	err error
}

func (c *Client) Put(ctx context.Context, name string, r io.Reader) (int64, error) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	free := make(chan []byte, 2)
	free <- make([]byte, PartSize)
	free <- make([]byte, PartSize)
	parts := make(chan part)
	go func() {
		defer close(parts)
		for {
			var buf []byte
			select {
			case buf = <-free:
			case <-ctx.Done():
				return
			}
			n, err := io.ReadFull(r, buf)
			last := errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF)
			if last {
				err = nil
			}
			select {
			case parts <- part{buf: buf, n: n, err: err}:
			case <-ctx.Done():
				return
			}
			if last || err != nil {
				return
			}
		}
	}()
	key := c.Key(name)
	var total int64
	var uploadID *string
	var done []types.CompletedPart
	abort := func(cause error) (int64, error) {
		if uploadID != nil {
			actx, acancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
			defer acancel()
			_, _ = c.api.AbortMultipartUpload(actx, &s3.AbortMultipartUploadInput{Bucket: &c.bucket, Key: &key, UploadId: uploadID})
		}
		return total, cause
	}
	for p := range parts {
		if p.err != nil {
			return abort(p.err)
		}
		last := p.n < len(p.buf)
		if uploadID == nil && last {
			_, err := c.api.PutObject(ctx, &s3.PutObjectInput{Bucket: &c.bucket, Key: &key, Body: bytes.NewReader(p.buf[:p.n]), ContentLength: aws.Int64(int64(p.n))})
			if err != nil {
				return abort(err)
			}
			return int64(p.n), nil
		}
		if uploadID == nil {
			out, err := c.api.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{Bucket: &c.bucket, Key: &key})
			if err != nil {
				return abort(err)
			}
			uploadID = out.UploadId
		}
		number := int32(len(done) + 1)
		if number > MaxParts {
			return abort(fmt.Errorf("the archive needs more than %d parts of %d MiB, which is the most one S3 object holds", MaxParts, PartSize>>20))
		}
		if p.n > 0 {
			out, err := c.api.UploadPart(ctx, &s3.UploadPartInput{Bucket: &c.bucket, Key: &key, UploadId: uploadID, PartNumber: aws.Int32(number), Body: bytes.NewReader(p.buf[:p.n]), ContentLength: aws.Int64(int64(p.n))})
			if err != nil {
				return abort(err)
			}
			done = append(done, types.CompletedPart{ETag: out.ETag, PartNumber: aws.Int32(number)})
			total += int64(p.n)
		}
		free <- p.buf
		if last {
			break
		}
	}
	if uploadID == nil {
		return abort(errors.New("the archive stream ended without data"))
	}
	if _, err := c.api.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{Bucket: &c.bucket, Key: &key, UploadId: uploadID, MultipartUpload: &types.CompletedMultipartUpload{Parts: done}}); err != nil {
		return abort(err)
	}
	return total, nil
}
