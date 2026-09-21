package main
import("encoding/json";"os")
func main(){
 var request map[string]interface{}
 if json.NewDecoder(os.Stdin).Decode(&request)!=nil { os.Exit(1) }
 result:=map[string]interface{}{"protocol":"station.process/v1","type":"result","output":map[string]interface{}{"input":request["input"],"token":os.Getenv("APPLICATION_TOKEN"),"uid":os.Getuid()}}
 if json.NewEncoder(os.Stdout).Encode(result)!=nil { os.Exit(2) }
}
