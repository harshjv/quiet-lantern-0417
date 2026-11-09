package upgrade

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"sync"

	"github.com/coreos/go-systemd/v22/daemon"
)

const HandoverEnv = "STATIONLY_HANDOVER"

type filer interface {
	File() (*os.File, error)
}

type handover struct {
	Ready   int            `json:"ready"`
	Sockets map[string]int `json:"sockets"`
}

var (
	mu        sync.Mutex
	live      = map[string]filer{}
	inherited = map[string]*os.File{}
	ready     *os.File
)

func LoadInherited() (bool, error) {
	raw := os.Getenv(HandoverEnv)
	if raw == "" {
		return false, nil
	}
	os.Unsetenv(HandoverEnv)
	var h handover
	if err := json.Unmarshal([]byte(raw), &h); err != nil {
		return false, fmt.Errorf("%s: %w", HandoverEnv, err)
	}
	mu.Lock()
	defer mu.Unlock()
	ready = os.NewFile(uintptr(h.Ready), "handover-ready")
	for key, fd := range h.Sockets {
		inherited[key] = os.NewFile(uintptr(fd), key)
	}
	return true, nil
}

func take(key string) *os.File {
	mu.Lock()
	defer mu.Unlock()
	f := inherited[key]
	delete(inherited, key)
	return f
}

func Inherited(key string) bool {
	mu.Lock()
	defer mu.Unlock()
	_, ok := inherited[key]
	return ok
}

func register(key string, f filer) {
	mu.Lock()
	live[key] = f
	mu.Unlock()
}

func Forget(key string) {
	mu.Lock()
	delete(live, key)
	mu.Unlock()
}

func Listen(key, network, addr string) (net.Listener, error) {
	if f := take(key); f != nil {
		ln, err := net.FileListener(f)
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("adopt inherited %s: %w", key, err)
		}
		register(key, ln.(filer))
		return ln, nil
	}
	ln, err := net.Listen(network, addr)
	if err != nil {
		return nil, err
	}
	register(key, ln.(filer))
	return ln, nil
}

func ListenPacket(key, network, addr string) (net.PacketConn, error) {
	if f := take(key); f != nil {
		pc, err := net.FilePacketConn(f)
		f.Close()
		if err != nil {
			return nil, fmt.Errorf("adopt inherited %s: %w", key, err)
		}
		register(key, pc.(filer))
		return pc, nil
	}
	pc, err := net.ListenPacket(network, addr)
	if err != nil {
		return nil, err
	}
	register(key, pc.(filer))
	return pc, nil
}

func Unclaimed() []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, 0, len(inherited))
	for k, f := range inherited {
		out = append(out, k)
		f.Close()
		delete(inherited, k)
	}
	sort.Strings(out)
	return out
}

func Live() []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, 0, len(live))
	for k := range live {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func SignalReady(detail string) error {
	mu.Lock()
	f := ready
	ready = nil
	mu.Unlock()
	if f == nil {
		return errors.New("not started by a handover")
	}
	defer f.Close()
	_, err := f.WriteString("ready " + detail + "\n")
	return err
}

type Child struct {
	Cmd   *exec.Cmd
	Ready <-chan string
	Exit  <-chan error
	Keys  []string
}

func Spawn(path string, args []string) (*Child, error) {
	mu.Lock()
	keys := make([]string, 0, len(live))
	for k := range live {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	files := make([]*os.File, 0, len(keys))
	var dupErr error
	for _, k := range keys {
		f, err := live[k].File()
		if err != nil {
			dupErr = fmt.Errorf("duplicate %s: %w", k, err)
			break
		}
		files = append(files, f)
	}
	mu.Unlock()
	closeAll := func() {
		for _, f := range files {
			f.Close()
		}
	}
	if dupErr != nil {
		closeAll()
		return nil, dupErr
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		closeAll()
		return nil, err
	}
	h := handover{Ready: 3, Sockets: map[string]int{}}
	for i, k := range keys {
		h.Sockets[k] = 4 + i
	}
	desc, _ := json.Marshal(h)
	cmd := exec.Command(path, args...)
	cmd.Env = append(os.Environ(), HandoverEnv+"="+string(desc))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	cmd.ExtraFiles = append([]*os.File{pw}, files...)
	if err := cmd.Start(); err != nil {
		pr.Close()
		pw.Close()
		closeAll()
		return nil, err
	}
	pw.Close()
	closeAll()
	readyC := make(chan string, 1)
	exitC := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(pr).ReadString('\n')
		pr.Close()
		if err == nil {
			readyC <- line
		}
		close(readyC)
	}()
	go func() { exitC <- cmd.Wait() }()
	return &Child{Cmd: cmd, Ready: readyC, Exit: exitC, Keys: keys}, nil
}

func Notify(state string) (bool, error) {
	return daemon.SdNotify(false, state)
}

func HandOver(pid int) (bool, error) {
	return daemon.SdNotify(false, "MAINPID="+strconv.Itoa(pid)+"\n"+daemon.SdNotifyReady)
}
