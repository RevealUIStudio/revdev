package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSubmitAgentTask_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent-tasks" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodPost {
			t.Errorf("unexpected method: %s", r.Method)
		}

		var req AgentTaskRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			t.Fatalf("decode: %v", err)
		}
		if req.Instruction != "deploy staging" {
			t.Errorf("Instruction = %q, want %q", req.Instruction, "deploy staging")
		}

		resp := AgentTaskResponse{
			Success:  true,
			TicketID: "ticket_001",
			Status:   "completed",
			Summary:  "Deployed to staging",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	result, err := c.SubmitAgentTask(AgentTaskRequest{
		Instruction: "deploy staging",
		BoardID:     "board_1",
	})
	if err != nil {
		t.Fatalf("SubmitAgentTask() error: %v", err)
	}
	if result.TicketID != "ticket_001" {
		t.Errorf("TicketID = %q, want %q", result.TicketID, "ticket_001")
	}
	if result.Status != "completed" {
		t.Errorf("Status = %q, want %q", result.Status, "completed")
	}
}

func TestSubmitAgentTask_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	_, err := c.SubmitAgentTask(AgentTaskRequest{
		Instruction: "test",
		BoardID:     "board_1",
	})
	if err == nil {
		t.Fatal("expected error for 500 response")
	}
}

func TestDispatchAgent_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/dispatch") {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}

		resp := AgentTaskResponse{
			Success:  true,
			TicketID: "ticket_002",
			Status:   "running",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	result, err := c.DispatchAgent("ticket_002")
	if err != nil {
		t.Fatalf("DispatchAgent() error: %v", err)
	}
	if result.Status != "running" {
		t.Errorf("Status = %q, want %q", result.Status, "running")
	}
}

func TestStreamAgent_ReturnsBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent-stream" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if accept := r.Header.Get("Accept"); accept != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", accept)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: {\"type\":\"content\",\"content\":\"hello\"}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	body, err := c.StreamAgent(AgentStreamRequest{
		Instruction: "test",
	})
	if err != nil {
		t.Fatalf("StreamAgent() error: %v", err)
	}
	defer body.Close()

	ch := make(chan AgentStreamEvent, 10)
	go ParseSSEEvents(body, ch)

	event := <-ch
	if event.Type != "content" {
		t.Errorf("event.Type = %q, want %q", event.Type, "content")
	}
	if event.Content != "hello" {
		t.Errorf("event.Content = %q, want %q", event.Content, "hello")
	}
}

func TestStreamAgent_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	_, err := c.StreamAgent(AgentStreamRequest{Instruction: "test"})
	if err == nil {
		t.Fatal("expected error for 403 response")
	}
}

func TestParseSSEEvents_MultipleEvents(t *testing.T) {
	data := "data: {\"type\":\"content\",\"content\":\"a\"}\n\ndata: {\"type\":\"tool\",\"tool\":\"search\"}\n\ndata: [DONE]\n\n"
	reader := strings.NewReader(data)

	ch := make(chan AgentStreamEvent, 10)
	go ParseSSEEvents(reader, ch)

	events := make([]AgentStreamEvent, 0)
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 2 {
		t.Fatalf("got %d events, want 2", len(events))
	}
	if events[0].Content != "a" {
		t.Errorf("events[0].Content = %q, want %q", events[0].Content, "a")
	}
	if events[1].Tool != "search" {
		t.Errorf("events[1].Tool = %q, want %q", events[1].Tool, "search")
	}
}

func TestParseSSEEvents_SkipsNonDataLines(t *testing.T) {
	data := ": comment\nevent: something\ndata: {\"type\":\"content\",\"content\":\"ok\"}\n\ndata: [DONE]\n\n"
	reader := strings.NewReader(data)

	ch := make(chan AgentStreamEvent, 10)
	go ParseSSEEvents(reader, ch)

	events := make([]AgentStreamEvent, 0)
	for e := range ch {
		events = append(events, e)
	}

	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
}

func TestConnectCollab_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/agent-collab/connect" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}

		resp := AgentCollabConnectResponse{
			Success:    true,
			WsURL:      "wss://api.revealui.com/collab/doc-001",
			DocumentID: "doc-001",
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(resp)
	}))
	defer server.Close()

	c := NewClient(server.URL, "tok_test")
	result, err := c.ConnectCollab(AgentCollabConnectRequest{
		DocumentID: "doc-001",
		AgentName:  "claude",
		AgentModel: "opus",
	})
	if err != nil {
		t.Fatalf("ConnectCollab() error: %v", err)
	}
	if result.WsURL != "wss://api.revealui.com/collab/doc-001" {
		t.Errorf("WsURL = %q", result.WsURL)
	}
}

func TestAgentTaskRequest_JSON(t *testing.T) {
	req := AgentTaskRequest{
		Instruction: "test task",
		BoardID:     "board_1",
		Priority:    "high",
	}
	data, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded AgentTaskRequest
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Instruction != req.Instruction {
		t.Errorf("Instruction = %q, want %q", decoded.Instruction, req.Instruction)
	}
}

func TestAgentStreamEvent_JSON(t *testing.T) {
	event := AgentStreamEvent{
		Type:    "content",
		Content: "hello world",
	}
	data, err := json.Marshal(event)
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}

	var decoded AgentStreamEvent
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if decoded.Type != "content" {
		t.Errorf("Type = %q, want %q", decoded.Type, "content")
	}
}
