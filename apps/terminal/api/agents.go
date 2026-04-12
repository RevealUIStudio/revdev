// Package api — agent-related API endpoints for RevDev coordination.
package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// AgentTaskRequest is the request body for POST /api/agent-tasks.
type AgentTaskRequest struct {
	Instruction string `json:"instruction"`
	BoardID     string `json:"boardId"`
	Priority    string `json:"priority,omitempty"`
}

// AgentTaskResponse is the response from POST /api/agent-tasks.
type AgentTaskResponse struct {
	Success  bool   `json:"success"`
	TicketID string `json:"ticketId"`
	Status   string `json:"status"`
	Summary  string `json:"summary,omitempty"`
	Error    string `json:"error,omitempty"`
}

// AgentStreamRequest is the request body for POST /api/agent-stream.
type AgentStreamRequest struct {
	Instruction string `json:"instruction"`
	BoardID     string `json:"boardId,omitempty"`
	WorkspaceID string `json:"workspaceId,omitempty"`
	Priority    string `json:"priority,omitempty"`
	Provider    string `json:"provider,omitempty"`
	Model       string `json:"model,omitempty"`
	Mode        string `json:"mode,omitempty"` // "admin" or "coding"
}

// AgentStreamEvent is a single SSE event from the agent stream.
type AgentStreamEvent struct {
	Type    string `json:"type"`
	Content string `json:"content,omitempty"`
	Status  string `json:"status,omitempty"`
	Tool    string `json:"tool,omitempty"`
	Result  string `json:"result,omitempty"`
	Error   string `json:"error,omitempty"`
}

// AgentCollabConnectRequest is the request for connecting to a collab session.
type AgentCollabConnectRequest struct {
	DocumentID string `json:"documentId"`
	AgentName  string `json:"agentName"`
	AgentModel string `json:"agentModel"`
	Color      string `json:"color,omitempty"`
}

// AgentCollabConnectResponse is the response with WebSocket URL for collab.
type AgentCollabConnectResponse struct {
	Success    bool   `json:"success"`
	WsURL      string `json:"wsUrl"`
	DocumentID string `json:"documentId"`
}

// ---------------------------------------------------------------------------
// Agent Task endpoints
// ---------------------------------------------------------------------------

// SubmitAgentTask submits a natural language task for an agent to execute.
func (c *Client) SubmitAgentTask(req AgentTaskRequest) (*AgentTaskResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal agent task: %w", err)
	}

	resp, err := c.authPost(fmt.Sprintf("%s/api/agent-tasks", c.baseURL), body)
	if err != nil {
		return nil, fmt.Errorf("agent task request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("agent task returned %d", resp.StatusCode)
	}

	var result AgentTaskResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode agent task response: %w", err)
	}
	return &result, nil
}

// DispatchAgent dispatches an agent for an existing ticket.
func (c *Client) DispatchAgent(ticketID string) (*AgentTaskResponse, error) {
	endpoint := fmt.Sprintf("%s/api/agent-tasks/%s/dispatch", c.baseURL, ticketID)
	resp, err := c.authPost(endpoint, []byte("{}"))
	if err != nil {
		return nil, fmt.Errorf("dispatch request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("dispatch returned %d", resp.StatusCode)
	}

	var result AgentTaskResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode dispatch response: %w", err)
	}
	return &result, nil
}

// ---------------------------------------------------------------------------
// Agent Stream (SSE)
// ---------------------------------------------------------------------------

// StreamAgent opens an SSE connection to POST /api/agent-stream.
// The caller must close the returned io.ReadCloser when done.
// Use ParseSSEEvents to read events from the stream.
func (c *Client) StreamAgent(req AgentStreamRequest) (io.ReadCloser, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal stream request: %w", err)
	}

	httpReq, err := http.NewRequest(http.MethodPost,
		fmt.Sprintf("%s/api/agent-stream", c.baseURL), bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Accept", "text/event-stream")
	if c.serviceToken != "" {
		httpReq.Header.Set("Authorization", "Bearer "+c.serviceToken)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("stream request failed: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		return nil, fmt.Errorf("stream returned %d", resp.StatusCode)
	}

	return resp.Body, nil
}

// ParseSSEEvents reads SSE events from a stream and sends them to a channel.
// Closes the channel when the stream ends or errors.
func ParseSSEEvents(reader io.Reader, ch chan<- AgentStreamEvent) {
	defer close(ch)
	scanner := bufio.NewScanner(reader)

	for scanner.Scan() {
		line := scanner.Text()
		if !strings.HasPrefix(line, "data: ") {
			continue
		}

		data := strings.TrimPrefix(line, "data: ")
		if data == "[DONE]" {
			return
		}

		var event AgentStreamEvent
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			continue
		}
		ch <- event
	}
}

// ---------------------------------------------------------------------------
// Agent Collab
// ---------------------------------------------------------------------------

// ConnectCollab requests a WebSocket URL for real-time document collaboration.
func (c *Client) ConnectCollab(req AgentCollabConnectRequest) (*AgentCollabConnectResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("marshal collab request: %w", err)
	}

	resp, err := c.authPost(fmt.Sprintf("%s/api/agent-collab/connect", c.baseURL), body)
	if err != nil {
		return nil, fmt.Errorf("collab connect failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("collab connect returned %d", resp.StatusCode)
	}

	var result AgentCollabConnectResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("decode collab response: %w", err)
	}
	return &result, nil
}
