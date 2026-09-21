// A native Station protocol fixture using only Go's standard library.
package main

import (
	"bufio"
	"encoding/json"
	"os"
	"time"
)

type object = map[string]any

func main() {
	encoder := json.NewEncoder(os.Stdout)
	send := func(frame object) {
		frame["protocol"] = "station.process/v1"
		if encoder.Encode(frame) != nil {
			os.Exit(2)
		}
	}
	input := make(chan object)
	go func() {
		defer close(input)
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 4096), 1024*1024)
		for scanner.Scan() {
			var frame object
			if json.Unmarshal(scanner.Bytes(), &frame) != nil {
				os.Exit(3)
			}
			input <- frame
		}
	}()
	ticker := time.NewTicker(40 * time.Millisecond)
	defer ticker.Stop()
	var config object
	var instance, incarnation any
	ready := false
	polls := 0
	journal := func(event string, data object) {
		if config == nil {
			return
		}
		path, _ := config["observed"].(string)
		if path == "" {
			return
		}
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0600)
		if err != nil {
			os.Exit(4)
		}
		defer file.Close()
		data["event"] = event
		data["instanceId"] = instance
		data["incarnation"] = incarnation
		if json.NewEncoder(file).Encode(data) != nil {
			os.Exit(5)
		}
		file.Sync()
	}
	for {
		select {
		case <-ticker.C:
			if ready {
				send(object{"type": "beacon:heartbeat"})
			}
		case frame, ok := <-input:
			if !ok {
				return
			}
			switch frame["type"] {
			case "invoke":
				send(object{"type": "result", "output": object{"native": true, "input": frame["input"], "token": os.Getenv("IMAGE_TOKEN")}})
				return
			case "beacon:init":
				config, _ = frame["config"].(map[string]any)
				instance = frame["instanceId"]
				incarnation = frame["incarnation"]
				journal("init", object{"config": config, "token": os.Getenv("IMAGE_TOKEN"), "hostOnly": os.Getenv("IMAGE_HOST_ONLY")})
				send(object{"type": "beacon:started"})
				send(object{"type": "beacon:ready"})
				ready = true
			case "beacon:poll":
				polls++
				journal("poll", object{"count": polls})
				if polls == 1 {
					trigger := object{"type": "trigger", "id": "once", "dependency": "echo", "input": object{"via": "native-beacon", "instanceId": instance, "incarnation": incarnation, "message": config["message"]}}
					send(trigger)
					send(trigger)
				}
				send(object{"type": "beacon:poll-completed", "invocationId": frame["invocationId"]})
			case "trigger:result":
				journal("trigger-result", object{"runId": frame["runId"]})
			case "trigger:error":
				journal("trigger-error", object{"error": frame["error"]})
			case "beacon:stop":
				ready = false
				journal("stopped", object{})
				send(object{"type": "beacon:stopped"})
				return
			}
		}
	}
}
