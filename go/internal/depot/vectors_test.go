package depot

import (
	"encoding/json"
	"os"
	"testing"
)

func TestDepotVectors(t *testing.T) {
	var v struct {
		Cases []struct {
			Name           string `json:"name"`
			ProjectID      string `json:"project_id"`
			RepositoryName string `json:"repository_name"`
			Prefix         string `json:"prefix"`
			Repository     string `json:"repository"`
		} `json:"cases"`
	}
	b, err := os.ReadFile("../../../packages/protocol/testdata/depot-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			if got := ProjectPrefix(c.ProjectID); got != c.Prefix {
				t.Errorf("ProjectPrefix = %s, want %s", got, c.Prefix)
			}
			if got := RepositoryFor(c.ProjectID, c.RepositoryName); got != c.Repository {
				t.Errorf("RepositoryFor = %s, want %s", got, c.Repository)
			}
			if !UnderProject(c.ProjectID, c.Repository) {
				t.Errorf("UnderProject(%s, %s) = false", c.ProjectID, c.Repository)
			}
		})
	}
}
